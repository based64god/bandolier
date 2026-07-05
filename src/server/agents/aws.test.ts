import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AwsCredentials,
  cleanSessionToken,
  validateAwsCredentials,
} from "~/server/agents/aws";

// Replace the STS client so validateAwsCredentials never talks to AWS. The fake
// records each constructor config (to assert what credentials/region were sent)
// and exposes shared send/destroy spies driven per-test.
const { sendMock, destroyMock, clientConfigs } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  destroyMock: vi.fn(),
  clientConfigs: [] as Array<{
    region: string;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    maxAttempts: number;
  }>,
}));

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    constructor(config: (typeof clientConfigs)[number]) {
      clientConfigs.push(config);
    }
    send = sendMock;
    destroy = destroyMock;
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

describe("cleanSessionToken", () => {
  it("returns a non-empty token trimmed of surrounding whitespace", () => {
    expect(cleanSessionToken("  tok123  ")).toBe("tok123");
  });

  it("returns a normal token unchanged", () => {
    expect(cleanSessionToken("tok123")).toBe("tok123");
  });

  it("returns undefined for null", () => {
    expect(cleanSessionToken(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(cleanSessionToken(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only string", () => {
    expect(cleanSessionToken("")).toBeUndefined();
    expect(cleanSessionToken("   ")).toBeUndefined();
  });
});

describe("validateAwsCredentials", () => {
  const creds: AwsCredentials = {
    accessKeyId: "AKIA1",
    secretAccessKey: "sec",
    sessionToken: null,
    region: "us-east-1",
  };

  /** Builds a rejection shaped like an AWS SDK service error. */
  function stsError(name: string, message = "raw aws msg") {
    return Object.assign(new Error(message), { name });
  }

  beforeEach(() => {
    sendMock.mockReset();
    destroyMock.mockReset();
    clientConfigs.length = 0;
  });

  it("returns the caller ARN and account when GetCallerIdentity succeeds", async () => {
    sendMock.mockResolvedValue({
      Arn: "arn:aws:iam::123:user/foo",
      Account: "123",
    });
    expect(await validateAwsCredentials(creds)).toEqual({
      valid: true,
      arn: "arn:aws:iam::123:user/foo",
      account: "123",
    });
  });

  it("forwards region and credentials with a single attempt, blanking a whitespace session token", async () => {
    sendMock.mockResolvedValue({ Arn: "a", Account: "1" });
    await validateAwsCredentials({ ...creds, sessionToken: "  " });
    expect(clientConfigs).toHaveLength(1);
    const config = clientConfigs[0]!;
    expect(config.region).toBe("us-east-1");
    expect(config.maxAttempts).toBe(1);
    expect(config.credentials.accessKeyId).toBe("AKIA1");
    expect(config.credentials.secretAccessKey).toBe("sec");
    // A blank token must become undefined, not "" — AWS rejects permanent
    // credentials that arrive with an empty session token.
    expect(config.credentials.sessionToken).toBeUndefined();
  });

  it("passes a real session token through trimmed", async () => {
    sendMock.mockResolvedValue({ Arn: "a", Account: "1" });
    await validateAwsCredentials({ ...creds, sessionToken: " tok " });
    expect(clientConfigs[0]!.credentials.sessionToken).toBe("tok");
  });

  it.each(["ExpiredToken", "ExpiredTokenException"])(
    "maps %s to an expiry message",
    async (name) => {
      sendMock.mockRejectedValue(stsError(name));
      expect(await validateAwsCredentials(creds)).toEqual({
        valid: false,
        error: "Credentials have expired.",
      });
    },
  );

  it("maps InvalidClientTokenId to an access-key-id message", async () => {
    sendMock.mockRejectedValue(stsError("InvalidClientTokenId"));
    const r = await validateAwsCredentials(creds);
    expect(r.valid).toBe(false);
    if (!r.valid)
      expect(r.error).toBe(
        "Access key ID is not recognized by AWS — it may be disabled, deleted, mistyped, or from a different account.",
      );
  });

  it("maps SignatureDoesNotMatch to a secret-key message", async () => {
    sendMock.mockRejectedValue(stsError("SignatureDoesNotMatch"));
    const r = await validateAwsCredentials(creds);
    expect(r.valid).toBe(false);
    if (!r.valid)
      expect(r.error).toBe(
        "Secret access key doesn't match the access key ID — check for a typo or copy/paste error.",
      );
  });

  it.each(["AccessDenied", "AccessDeniedException"])(
    "maps %s to a not-authorized message",
    async (name) => {
      sendMock.mockRejectedValue(stsError(name));
      expect(await validateAwsCredentials(creds)).toEqual({
        valid: false,
        error: "Credentials are valid but not authorized for this action.",
      });
    },
  );

  it("passes the raw message through for an unrecognized error name", async () => {
    sendMock.mockRejectedValue(stsError("ValidationError", "boom"));
    expect(await validateAwsCredentials(creds)).toEqual({
      valid: false,
      error: "boom",
    });
  });

  it("falls back to a generic message when the error has no name or message", async () => {
    sendMock.mockRejectedValue({});
    expect(await validateAwsCredentials(creds)).toEqual({
      valid: false,
      error: "Credentials are invalid.",
    });
  });

  it("destroys the client after a successful call", async () => {
    sendMock.mockResolvedValue({ Arn: "a", Account: "1" });
    await validateAwsCredentials(creds);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("destroys the client even when the call fails", async () => {
    sendMock.mockRejectedValue(stsError("ExpiredToken"));
    await validateAwsCredentials(creds);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
