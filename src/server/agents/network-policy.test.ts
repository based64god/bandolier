import { describe, expect, it } from "vitest";

import {
  buildCustomNetworkPolicyBody,
  buildNetworkPolicyBody,
  NETWORK_POLICY_NAME,
  validateNetworkPolicyYaml,
} from "~/server/agents/network-policy";

// The default in-cluster block list (mirrors the AGENT_EGRESS_BLOCKED_CIDRS
// default). The toggles operate relative to this baseline.
const BLOCKED = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

// Narrow shapes for reaching into the built policy without `any`.
interface EgressPort {
  protocol: string;
  port: number;
}
interface EgressRule {
  to: { ipBlock?: { cidr: string; except?: string[] } }[];
  ports?: EgressPort[];
}
interface PolicyBody {
  metadata: { name: string; namespace: string };
  spec: { ingress: unknown[]; egress: EgressRule[] };
}

// The second egress rule is the internet/in-cluster one; the first is DNS.
function internetRule(body: object): EgressRule {
  return (body as PolicyBody).spec.egress[1]!;
}

describe("buildNetworkPolicyBody", () => {
  it("denies inbound and names the namespace's isolation policy", () => {
    const body = buildNetworkPolicyBody("ns", BLOCKED) as PolicyBody;
    expect(body.metadata.name).toBe(NETWORK_POLICY_NAME);
    expect(body.metadata.namespace).toBe("ns");
    expect(body.spec.ingress).toEqual([]);
  });

  it("by default blocks in-cluster CIDRs and limits egress to 80/443", () => {
    const rule = internetRule(buildNetworkPolicyBody("ns", BLOCKED));
    expect(rule.to[0]!.ipBlock).toEqual({
      cidr: "0.0.0.0/0",
      except: BLOCKED,
    });
    expect(rule.ports).toEqual([
      { protocol: "TCP", port: 443 },
      { protocol: "TCP", port: 80 },
    ]);
  });

  it("allowPrivateEgress drops the in-cluster CIDR block", () => {
    const rule = internetRule(
      buildNetworkPolicyBody("ns", BLOCKED, { allowPrivateEgress: true }),
    );
    expect(rule.to[0]!.ipBlock).toEqual({ cidr: "0.0.0.0/0" });
    expect(rule.to[0]!.ipBlock!.except).toBeUndefined();
    // Ports stay restricted unless the other toggle is set.
    expect(rule.ports).toEqual([
      { protocol: "TCP", port: 443 },
      { protocol: "TCP", port: 80 },
    ]);
  });

  it("allowAllPortsEgress removes the port restriction but keeps the CIDR block", () => {
    const rule = internetRule(
      buildNetworkPolicyBody("ns", BLOCKED, { allowAllPortsEgress: true }),
    );
    expect(rule.ports).toBeUndefined();
    expect(rule.to[0]!.ipBlock).toEqual({
      cidr: "0.0.0.0/0",
      except: BLOCKED,
    });
  });

  it("both toggles together open all ports and all destinations", () => {
    const rule = internetRule(
      buildNetworkPolicyBody("ns", BLOCKED, {
        allowPrivateEgress: true,
        allowAllPortsEgress: true,
      }),
    );
    expect(rule.ports).toBeUndefined();
    expect(rule.to[0]!.ipBlock).toEqual({ cidr: "0.0.0.0/0" });
  });

  it("an empty block list yields a plain 0.0.0.0/0 (no empty except)", () => {
    const rule = internetRule(buildNetworkPolicyBody("ns", []));
    expect(rule.to[0]!.ipBlock).toEqual({ cidr: "0.0.0.0/0" });
  });
});

// A minimal well-formed custom policy used across the advanced-config tests.
const VALID_YAML = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: my-policy
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: []
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8]
      ports:
        - protocol: TCP
          port: 443
`;

describe("validateNetworkPolicyYaml", () => {
  it("accepts a well-formed NetworkPolicy", () => {
    expect(validateNetworkPolicyYaml(VALID_YAML)).toEqual({ valid: true });
  });

  it("accepts a podSelector targeting the agent label", () => {
    const yaml = VALID_YAML.replace(
      "podSelector: {}",
      "podSelector:\n    matchLabels:\n      app: bandolier-agent",
    );
    expect(validateNetworkPolicyYaml(yaml)).toEqual({ valid: true });
  });

  it("rejects unparseable YAML", () => {
    const result = validateNetworkPolicyYaml("foo: [unclosed");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/Invalid YAML/);
  });

  it("rejects a non-mapping document", () => {
    expect(validateNetworkPolicyYaml("just a string").valid).toBe(false);
    expect(validateNetworkPolicyYaml("- a\n- list").valid).toBe(false);
  });

  it("rejects the wrong kind and apiVersion", () => {
    const result = validateNetworkPolicyYaml(
      VALID_YAML.replace("kind: NetworkPolicy", "kind: Pod"),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("kind");
  });

  it("rejects a missing spec", () => {
    const result = validateNetworkPolicyYaml(
      "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\n",
    );
    expect(result.valid).toBe(false);
  });

  it("rejects unknown fields (typo protection)", () => {
    const result = validateNetworkPolicyYaml(
      VALID_YAML.replace("egress:", "egres:"),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("egres");
  });

  it("rejects an invalid CIDR and an out-of-range port", () => {
    expect(
      validateNetworkPolicyYaml(
        VALID_YAML.replace("cidr: 0.0.0.0/0", "cidr: not-a-cidr"),
      ).valid,
    ).toBe(false);
    expect(
      validateNetworkPolicyYaml(VALID_YAML.replace("port: 443", "port: 70000"))
        .valid,
    ).toBe(false);
  });

  it("rejects a peer mixing ipBlock with selectors, and an empty peer", () => {
    const mixed = VALID_YAML.replace(
      "        - ipBlock:",
      "        - podSelector: {}\n          ipBlock:",
    );
    expect(validateNetworkPolicyYaml(mixed).valid).toBe(false);
    const empty = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
spec:
  podSelector: {}
  egress:
    - to:
        - {}
`;
    expect(validateNetworkPolicyYaml(empty).valid).toBe(false);
  });

  it("rejects a podSelector that can never match agent pods", () => {
    const yaml = VALID_YAML.replace(
      "podSelector: {}",
      "podSelector:\n    matchLabels:\n      app: something-else",
    );
    const result = validateNetworkPolicyYaml(yaml);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("bandolier-agent");
  });
});

describe("buildCustomNetworkPolicyBody", () => {
  it("overrides metadata to the managed name/namespace and label", () => {
    const body = buildCustomNetworkPolicyBody("ns", VALID_YAML) as PolicyBody;
    expect(body.metadata.name).toBe(NETWORK_POLICY_NAME);
    expect(body.metadata.namespace).toBe("ns");
    const labels = (
      body.metadata as unknown as { labels: Record<string, string> }
    ).labels;
    expect(labels["app.kubernetes.io/managed-by"]).toBe("bandolier");
    // The spec is taken from the YAML untouched.
    expect(body.spec.egress).toHaveLength(1);
  });

  it("throws on unparseable YAML (deploy fails closed)", () => {
    expect(() => buildCustomNetworkPolicyBody("ns", "foo: [")).toThrow();
    expect(() => buildCustomNetworkPolicyBody("ns", "just a string")).toThrow();
  });
});
