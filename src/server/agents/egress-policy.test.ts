import { describe, expect, it } from "vitest";

import { buildEgressRules } from "~/server/agents/create-job";

const BLOCKED = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

// Pull the public-internet rule (the one with an ipBlock) out of the rule set.
function publicRule(
  rules: object[],
): { to: { ipBlock: { cidr: string; except: string[] } }[] } | undefined {
  return rules.find(
    (r): r is { to: { ipBlock: { cidr: string; except: string[] } }[] } =>
      Array.isArray((r as { to?: unknown[] }).to) &&
      (r as { to: { ipBlock?: unknown }[] }).to.some((t) => "ipBlock" in t),
  );
}

describe("buildEgressRules", () => {
  it("defaults to DNS + public internet with private ranges blocked", () => {
    const rules = buildEgressRules(undefined, BLOCKED);
    // Two rules: DNS and public internet.
    expect(rules).toHaveLength(2);
    const pub = publicRule(rules);
    expect(pub?.to[0]?.ipBlock.cidr).toBe("0.0.0.0/0");
    expect(pub?.to[0]?.ipBlock.except).toEqual(BLOCKED);
  });

  it("drops the public rule when public egress is disabled (DNS only)", () => {
    const rules = buildEgressRules(
      { allowPublicEgress: false, allowPrivateEgress: false },
      BLOCKED,
    );
    expect(rules).toHaveLength(1);
    expect(publicRule(rules)).toBeUndefined();
  });

  it("removes the except list when private egress is allowed", () => {
    const rules = buildEgressRules(
      { allowPublicEgress: true, allowPrivateEgress: true },
      BLOCKED,
    );
    const pub = publicRule(rules);
    expect(pub?.to[0]?.ipBlock.cidr).toBe("0.0.0.0/0");
    expect(pub?.to[0]?.ipBlock.except).toEqual([]);
  });

  it("always allows DNS regardless of toggles", () => {
    for (const allowPublicEgress of [true, false]) {
      for (const allowPrivateEgress of [true, false]) {
        const rules = buildEgressRules(
          { allowPublicEgress, allowPrivateEgress },
          BLOCKED,
        );
        const dns = rules.find((r) =>
          (r as { ports?: { port: number }[] }).ports?.some(
            (p) => p.port === 53,
          ),
        );
        expect(dns).toBeDefined();
      }
    }
  });

  it("treats omitted toggles as the safe baseline (public on, private off)", () => {
    const rules = buildEgressRules({}, BLOCKED);
    expect(rules).toHaveLength(2);
    expect(publicRule(rules)?.to[0]?.ipBlock.except).toEqual(BLOCKED);
  });
});
