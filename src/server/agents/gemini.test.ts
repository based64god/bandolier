import { describe, expect, it } from "vitest";

import {
  parseGoogleCredentials,
  summarizeGeminiCredentials,
} from "~/server/agents/gemini";

const validServiceAccount = JSON.stringify({
  type: "service_account",
  project_id: "my-project",
  client_email: "agent@my-project.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIstub\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
});

describe("parseGoogleCredentials", () => {
  it("accepts a well-formed service-account key", () => {
    const { creds, error } = parseGoogleCredentials(validServiceAccount);
    expect(error).toBeUndefined();
    expect(creds?.project_id).toBe("my-project");
  });

  it("rejects non-JSON (e.g. a pasted API key)", () => {
    const { creds, error } = parseGoogleCredentials("AIzaSyExampleApiKey");
    expect(creds).toBeUndefined();
    expect(error).toMatch(/JSON/i);
  });

  it("rejects a JSON object that isn't a service-account key", () => {
    const { error } = parseGoogleCredentials(
      JSON.stringify({ type: "authorized_user", project_id: "p" }),
    );
    expect(error).toMatch(/service-account/i);
  });

  it("lists the fields a service-account key is missing", () => {
    const { error } = parseGoogleCredentials(
      JSON.stringify({ type: "service_account", project_id: "p" }),
    );
    expect(error).toContain("client_email");
    expect(error).toContain("private_key");
  });
});

describe("summarizeGeminiCredentials", () => {
  it("extracts the project and service-account email, never the key", () => {
    const summary = summarizeGeminiCredentials(validServiceAccount);
    expect(summary).toEqual({
      projectId: "my-project",
      clientEmail: "agent@my-project.iam.gserviceaccount.com",
    });
  });

  it("returns nulls for an unparseable value", () => {
    expect(summarizeGeminiCredentials("not json")).toEqual({
      projectId: null,
      clientEmail: null,
    });
  });
});
