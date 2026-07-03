import { describe, expect, it } from "vitest";

import {
  getKubeconfigServer,
  unsupportedKubeconfigAuth,
} from "~/server/k8s/client";

// unsupportedKubeconfigAuth and getKubeconfigServer are real parsing logic on
// top of @kubernetes/client-node's loadFromString, which is a hermetic parser —
// no cluster access happens, so no mocks are needed. The four get*Api factories
// are one-line makeApiClient glue and are deliberately not tested beyond the
// shared empty-input guard they all route through.

/**
 * A minimal valid kubeconfig (cluster c1 → https://1.2.3.4:6443, context ctx,
 * user u1) with the user's auth block injected. `clusterExtra` appends fields
 * to the cluster entry (e.g. an on-disk certificate-authority path).
 */
function kubeconfigWith(userBlock: string, clusterExtra = ""): string {
  return `
apiVersion: v1
kind: Config
clusters:
  - name: c1
    cluster:
      server: https://1.2.3.4:6443
${clusterExtra}
contexts:
  - name: ctx
    context:
      cluster: c1
      user: u1
current-context: ctx
users:
  - name: u1
    user:
${userBlock}
`;
}

describe("unsupportedKubeconfigAuth", () => {
  it("accepts a self-contained token config", () => {
    expect(
      unsupportedKubeconfigAuth(kubeconfigWith("      token: abc")),
    ).toBeNull();
  });

  it("accepts inline client-certificate data (only file paths are rejected)", () => {
    expect(
      unsupportedKubeconfigAuth(
        kubeconfigWith(
          "      client-certificate-data: YWJj\n      client-key-data: ZGVm",
        ),
      ),
    ).toBeNull();
  });

  it("rejects an exec credential plugin, naming its command", () => {
    const reason = unsupportedKubeconfigAuth(
      kubeconfigWith(
        "      exec:\n" +
          "        apiVersion: client.authentication.k8s.io/v1beta1\n" +
          "        command: aws\n" +
          "        args: []",
      ),
    );
    expect(reason).toContain("exec credential plugin");
    expect(reason).toContain("(`aws`)");
  });

  it("rejects an exec plugin without a command, omitting the name", () => {
    const reason = unsupportedKubeconfigAuth(
      kubeconfigWith(
        "      exec:\n" +
          "        apiVersion: client.authentication.k8s.io/v1beta1\n" +
          "        args: []",
      ),
    );
    expect(reason).toContain("exec credential plugin");
    expect(reason).not.toContain("(`");
  });

  it("rejects an auth provider, naming it", () => {
    const reason = unsupportedKubeconfigAuth(
      kubeconfigWith(
        "      auth-provider:\n        name: gcp\n        config: {}",
      ),
    );
    expect(reason).toContain("auth provider");
    expect(reason).toContain("(`gcp`)");
  });

  it("rejects client certificate/key paths on disk, suggesting the inline form", () => {
    const reason = unsupportedKubeconfigAuth(
      kubeconfigWith(
        "      client-certificate: /tmp/cert.pem\n      client-key: /tmp/key.pem",
      ),
    );
    expect(reason).toContain("certificate/key files on disk");
    expect(reason).toContain("client-certificate-data");
  });

  it("rejects an on-disk cluster CA path even when the user auth is a token", () => {
    const reason = unsupportedKubeconfigAuth(
      kubeconfigWith(
        "      token: abc",
        "      certificate-authority: /etc/ca.crt",
      ),
    );
    expect(reason).toContain("certificate/key files on disk");
  });

  it("throws on an empty kubeconfig", () => {
    expect(() => unsupportedKubeconfigAuth("")).toThrow(
      "No kubeconfig provided.",
    );
  });

  it("propagates the YAML parse error for a malformed config", () => {
    expect(() => unsupportedKubeconfigAuth("not: [valid yaml")).toThrow(
      /unexpected end/,
    );
  });
});

describe("getKubeconfigServer", () => {
  it("returns the current cluster's server URL", () => {
    expect(getKubeconfigServer(kubeconfigWith("      token: abc"))).toBe(
      "https://1.2.3.4:6443",
    );
  });

  it("returns null when the current context names a nonexistent context", () => {
    const dangling = kubeconfigWith("      token: abc").replace(
      "current-context: ctx",
      "current-context: missing",
    );
    expect(getKubeconfigServer(dangling)).toBeNull();
  });

  it("throws on an empty kubeconfig", () => {
    expect(() => getKubeconfigServer("")).toThrow("No kubeconfig provided.");
  });
});
