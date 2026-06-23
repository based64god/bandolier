import { describe, expect, it } from "vitest";

import {
  buildNetworkPolicyBody,
  NETWORK_POLICY_NAME,
} from "~/server/agents/create-job";

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
