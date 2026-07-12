import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import type { db as Database } from "~/server/db";
import {
  type ArtifactStore,
  getArtifact,
  putArtifact,
  repoArtifactStore,
  resolveArtifactStore,
  transcriptKey,
  validateArtifactStore,
} from "~/server/agents/artifacts";

// Mock the S3 SDK so validate/get exercise the module's error mapping and
// client construction without any network access. Every constructed client is
// captured for inspection; `sendImpl` swaps the probe behavior per test.
const s3State = vi.hoisted(() => ({
  clients: [] as {
    config: Record<string, unknown>;
    send: Mock;
    destroy: Mock;
  }[],
  sendImpl: null as ((cmd: unknown) => Promise<unknown>) | null,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class FakeCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class PutObjectCommand extends FakeCommand {}
  class GetObjectCommand extends FakeCommand {}
  class DeleteObjectCommand extends FakeCommand {}
  class S3Client {
    send = vi.fn((cmd: unknown) =>
      s3State.sendImpl ? s3State.sendImpl(cmd) : Promise.resolve({}),
    );
    destroy = vi.fn();
    constructor(readonly config: Record<string, unknown>) {
      s3State.clients.push(this);
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

beforeEach(() => {
  s3State.clients.length = 0;
  s3State.sendImpl = null;
});

const emptyRow = {
  artifactsS3Bucket: null,
  artifactsS3Region: null,
  artifactsS3Endpoint: null,
  artifactsAccessKeyId: null,
  artifactsSecretAccessKey: null,
};

describe("repoArtifactStore", () => {
  it("returns null when the repo has no bucket configured", () => {
    expect(repoArtifactStore(emptyRow)).toBeNull();
  });

  it("maps a fully-configured row to a store", () => {
    expect(
      repoArtifactStore({
        artifactsS3Bucket: "acme-run-logs",
        artifactsS3Region: "eu-west-1",
        artifactsS3Endpoint: "https://minio.acme.dev",
        artifactsAccessKeyId: "AKIA123",
        artifactsSecretAccessKey: "secret",
      }),
    ).toEqual({
      bucket: "acme-run-logs",
      region: "eu-west-1",
      endpoint: "https://minio.acme.dev",
      credentials: { accessKeyId: "AKIA123", secretAccessKey: "secret" },
    });
  });

  it("defaults the region and omits the endpoint when unset", () => {
    const store = repoArtifactStore({
      ...emptyRow,
      artifactsS3Bucket: "acme-run-logs",
      artifactsAccessKeyId: "AKIA123",
      artifactsSecretAccessKey: "secret",
    });
    expect(store?.region).toBe("us-east-1");
    expect(store?.endpoint).toBeUndefined();
  });

  it("returns null unless both halves of the key pair are present", () => {
    // The mutation stores the config only as a complete set, so a partial row
    // means something is off — treat it as unconfigured, not half-usable.
    expect(
      repoArtifactStore({
        ...emptyRow,
        artifactsS3Bucket: "acme-run-logs",
        artifactsAccessKeyId: "AKIA123",
      }),
    ).toBeNull();
  });
});

describe("transcriptKey", () => {
  it("namespaces the transcript under the run's job name", () => {
    expect(transcriptKey("agent-abc123")).toBe(
      "runs/agent-abc123/transcript.log",
    );
  });
});

// ── S3-backed halves (mocked SDK) ────────────────────────────────────────────

/** A repo-config store with a custom (MinIO-style) endpoint. */
const minioStore: ArtifactStore = {
  bucket: "acme-run-logs",
  region: "eu-west-1",
  endpoint: "https://minio.acme.dev",
  credentials: { accessKeyId: "AKIA123", secretAccessKey: "secret" },
};

/** The same store pointed at plain AWS S3 (no custom endpoint). */
const awsStore: ArtifactStore = {
  bucket: "acme-run-logs",
  region: "us-east-1",
  credentials: { accessKeyId: "AKIA123", secretAccessKey: "secret" },
};

/** A database stub whose select→from→where→limit chain resolves the rows. */
function dbSelect(rows: unknown[]) {
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  }));
  return { db: { select } as unknown as typeof Database, select };
}

function lastClient() {
  return s3State.clients.at(-1)!;
}

/** An S3-style error: an Error whose `name` carries the service error code. */
function s3Error(name: string, message = "raw failure") {
  return Object.assign(new Error(message), { name });
}

describe("resolveArtifactStore", () => {
  const fullRow = {
    artifactsS3Bucket: "acme-run-logs",
    artifactsS3Region: "eu-west-1",
    artifactsS3Endpoint: "https://minio.acme.dev",
    artifactsAccessKeyId: "AKIA123",
    artifactsSecretAccessKey: "secret",
  };

  it("returns null for runs without a repo, without querying the db", async () => {
    const { db, select } = dbSelect([fullRow]);
    expect(await resolveArtifactStore(db, null)).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("maps the repo's config row to a store", async () => {
    const { db } = dbSelect([fullRow]);
    expect(await resolveArtifactStore(db, "acme/widgets")).toEqual(minioStore);
  });

  it("returns null when the repo has no config row", async () => {
    const { db } = dbSelect([]);
    expect(await resolveArtifactStore(db, "acme/widgets")).toBeNull();
  });
});

describe("validateArtifactStore", () => {
  it("is valid when the write probe succeeds, and cleans the probe up", async () => {
    expect(await validateArtifactStore(minioStore)).toEqual({ valid: true });
    const sent = lastClient().send.mock.calls.map(
      (c) => c[0] as { input: Record<string, unknown> },
    );
    // The probe exercises exactly s3:PutObject on the configured bucket…
    expect(sent[0]!.input).toMatchObject({
      Bucket: "acme-run-logs",
      Key: "bandolier/write-probe",
    });
    // …then best-effort deletes the probe object.
    expect(sent[1]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[1]!.input).toMatchObject({
      Bucket: "acme-run-logs",
      Key: "bandolier/write-probe",
    });
    expect(lastClient().destroy).toHaveBeenCalledTimes(1);
  });

  it("stays valid when the cleanup delete is refused (write-only credentials)", async () => {
    s3State.sendImpl = (cmd) =>
      cmd instanceof DeleteObjectCommand
        ? Promise.reject(s3Error("AccessDenied"))
        : Promise.resolve({});
    expect(await validateArtifactStore(minioStore)).toEqual({ valid: true });
  });

  it.each([
    [
      "NoSuchBucket",
      "The bucket does not exist — check the name, region, and endpoint.",
    ],
    [
      "InvalidAccessKeyId",
      "Access key ID is not recognized — it may be disabled, deleted, or mistyped.",
    ],
    [
      "SignatureDoesNotMatch",
      "Secret access key doesn't match the access key ID — check for a typo or copy/paste error.",
    ],
    [
      "AccessDenied",
      "Credentials are valid but not allowed to write to this bucket — grant s3:PutObject on it.",
    ],
    [
      "PermanentRedirect",
      "The bucket lives in a different region than the one given.",
    ],
  ])("maps a %s probe failure to its friendly message", async (name, error) => {
    s3State.sendImpl = () => Promise.reject(s3Error(name));
    expect(await validateArtifactStore(minioStore)).toEqual({
      valid: false,
      error,
    });
    // The client is torn down on the failure path too.
    expect(lastClient().destroy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the error's own message for an unknown code", async () => {
    s3State.sendImpl = () =>
      Promise.reject(s3Error("SomethingElse", "socket hang up"));
    expect(await validateArtifactStore(minioStore)).toEqual({
      valid: false,
      error: "socket hang up",
    });
  });

  it("falls back to a generic message when the error has none", async () => {
    // An error with no message at all (some SDK failures carry none).
    const err = Object.assign(new Error(), {
      name: "SomethingElse",
      message: undefined,
    });
    s3State.sendImpl = () => Promise.reject(err);
    expect(await validateArtifactStore(minioStore)).toEqual({
      valid: false,
      error: "Could not write to the bucket.",
    });
  });
});

describe("getArtifact", () => {
  it("returns the object body as a string", async () => {
    s3State.sendImpl = () =>
      Promise.resolve({
        Body: { transformToString: () => Promise.resolve("log line") },
      });
    expect(await getArtifact(minioStore, "runs/j/transcript.log")).toBe(
      "log line",
    );
    const cmd = lastClient().send.mock.calls[0]![0] as {
      input: Record<string, unknown>;
    };
    expect(cmd.input).toEqual({
      Bucket: "acme-run-logs",
      Key: "runs/j/transcript.log",
    });
  });

  it("returns null when the response has no body", async () => {
    s3State.sendImpl = () => Promise.resolve({});
    expect(await getArtifact(minioStore, "k")).toBeNull();
  });

  it("returns null when the read fails", async () => {
    s3State.sendImpl = () => Promise.reject(s3Error("NoSuchKey"));
    expect(await getArtifact(minioStore, "k")).toBeNull();
    expect(lastClient().destroy).toHaveBeenCalledTimes(1);
  });
});

describe("putArtifact", () => {
  it("writes the body as a PutObject with the default content type, then tears the client down", async () => {
    await putArtifact(minioStore, "runs/j/transcript.log", "log line");
    const cmd = lastClient().send.mock.calls[0]![0] as {
      input: Record<string, unknown>;
    };
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    // The default content type is applied when the caller omits it.
    expect(cmd.input).toEqual({
      Bucket: "acme-run-logs",
      Key: "runs/j/transcript.log",
      Body: "log line",
      ContentType: "text/plain; charset=utf-8",
    });
    expect(lastClient().destroy).toHaveBeenCalledTimes(1);
  });

  it("honors a caller-supplied content type", async () => {
    await putArtifact(minioStore, "runs/j/meta.json", "{}", "application/json");
    const cmd = lastClient().send.mock.calls[0]![0] as {
      input: Record<string, unknown>;
    };
    expect(cmd.input).toMatchObject({
      Key: "runs/j/meta.json",
      Body: "{}",
      ContentType: "application/json",
    });
  });

  it("propagates the write error but still destroys the client", async () => {
    // Unlike getArtifact, putArtifact deliberately doesn't swallow failures —
    // the caller decides how a failed persist is handled — but the finally
    // block still tears the client down.
    s3State.sendImpl = () => Promise.reject(s3Error("AccessDenied", "denied"));
    await expect(putArtifact(minioStore, "k", "body")).rejects.toThrow(
      "denied",
    );
    expect(lastClient().destroy).toHaveBeenCalledTimes(1);
  });
});

describe("s3 client construction", () => {
  it("uses path-style addressing only when a custom endpoint is set", async () => {
    // Path-style is safest for MinIO/S3-compatible endpoints…
    await validateArtifactStore(minioStore);
    expect(lastClient().config).toMatchObject({
      region: "eu-west-1",
      endpoint: "https://minio.acme.dev",
      forcePathStyle: true,
      credentials: minioStore.credentials,
    });

    // …but plain AWS S3 keeps the default virtual-hosted style.
    await validateArtifactStore(awsStore);
    expect(lastClient().config.endpoint).toBeUndefined();
    expect(lastClient().config.forcePathStyle).toBe(false);
  });
});
