import { describe, expect, it } from "vitest";

import { repoArtifactStore, transcriptKey } from "~/server/agents/artifacts";

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
