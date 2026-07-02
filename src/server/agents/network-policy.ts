import { isIP } from "node:net";

// Plain js-yaml, NOT @kubernetes/client-node's loadYaml: that helper
// deserializes into the typed model for the document's kind and silently drops
// unknown fields — which would erase exactly the typos validation exists to
// catch (and quietly reshape a custom policy at apply time).
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { z } from "zod";

import { env } from "~/env";

/** Name of the per-namespace NetworkPolicy that isolates agent pods. */
export const NETWORK_POLICY_NAME = "bandolier-agent-isolation";

/**
 * Per-repo loosenings of the default agent egress rules, applied to the
 * namespace's NetworkPolicy. Both default off (the locked-down baseline); each
 * widens what agent pods can reach. See `repoWebhookConfig` and the repo-config
 * UI's security warning.
 */
export interface NetworkPolicyOptions {
  /**
   * Allow egress to private / in-cluster (RFC-1918) ranges by dropping the
   * AGENT_EGRESS_BLOCKED_CIDRS exclusion. Lets agents reach other pods and
   * in-cluster services (lateral-movement risk).
   */
  allowPrivateEgress?: boolean;
  /**
   * Allow egress on any TCP port instead of only 80/443. Widens the
   * exfiltration / arbitrary-protocol surface.
   */
  allowAllPortsEgress?: boolean;
  /**
   * Advanced: raw NetworkPolicy YAML that replaces the built-in policy — and
   * with it both toggles above — entirely. Validated on save (see
   * `validateNetworkPolicyYaml`); at apply time its metadata is overridden to
   * the managed name/namespace so create/replace keep targeting the one
   * managed policy. Null/unset = the built-in policy with the toggles.
   */
  policyYaml?: string | null;
}

/** The in-cluster CIDR block list configured via AGENT_EGRESS_BLOCKED_CIDRS. */
export function agentEgressBlockedCidrs(): string[] {
  return env.AGENT_EGRESS_BLOCKED_CIDRS.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Builds the agent-isolation NetworkPolicy body for a namespace, applying the
 * per-repo egress toggles to the default rules. Pure (no cluster access) so the
 * toggle logic is unit-testable. `blockedCidrs` is the configured in-cluster
 * block list (from AGENT_EGRESS_BLOCKED_CIDRS), dropped when private egress is
 * allowed.
 */
export function buildNetworkPolicyBody(
  namespace: string,
  blockedCidrs: string[],
  opts?: NetworkPolicyOptions,
): object {
  // `allowPrivateEgress` drops the in-cluster CIDR block; otherwise the
  // configured private ranges stay unreachable.
  const blocked = opts?.allowPrivateEgress ? [] : blockedCidrs;

  // `allowAllPortsEgress` lifts the 80/443 restriction (omitting `ports`
  // altogether means every port); otherwise only HTTP(S) is allowed out.
  const internetPorts = opts?.allowAllPortsEgress
    ? undefined
    : [
        { protocol: "TCP" as const, port: 443 },
        { protocol: "TCP" as const, port: 80 },
      ];

  const ipBlock =
    blocked.length > 0
      ? { cidr: "0.0.0.0/0", except: blocked }
      : { cidr: "0.0.0.0/0" };

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: NETWORK_POLICY_NAME,
      namespace,
      labels: { "app.kubernetes.io/managed-by": "bandolier" },
    },
    spec: {
      podSelector: { matchLabels: { app: "bandolier-agent" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [], // deny all inbound
      egress: [
        {
          // DNS resolution via kube-dns.
          to: [
            {
              namespaceSelector: {},
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          // Public internet (and, when allowed, in-cluster ranges), restricted
          // to HTTP(S) unless all ports are permitted.
          to: [{ ipBlock }],
          ...(internetPorts && { ports: internetPorts }),
        },
      ],
    },
  };
}

/**
 * The policy a repo's namespaces get when no custom YAML is set, rendered as
 * YAML. Shown in the repo-config UI as the starting point for the advanced
 * raw-YAML editor, so admins edit the real effective policy rather than
 * writing one from scratch.
 */
export function renderDefaultNetworkPolicyYaml(
  namespace: string,
  opts?: NetworkPolicyOptions,
): string {
  return dumpYaml(
    buildNetworkPolicyBody(namespace, agentEgressBlockedCidrs(), opts),
  );
}

/**
 * A custom-policy NetworkPolicy body ready to apply: the repo's saved YAML with
 * its metadata overridden to the managed name/namespace (and managed-by label),
 * so create/replace keep targeting the one policy Bandolier owns regardless of
 * what the YAML's own metadata says. Throws on unparseable YAML — the caller
 * (job creation) must fail closed rather than deploy without the intended
 * policy.
 */
export function buildCustomNetworkPolicyBody(
  namespace: string,
  policyYaml: string,
): object {
  const doc = loadYaml(policyYaml) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") {
    throw new Error("Custom network policy YAML is not a mapping.");
  }
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const labels = (metadata.labels ?? {}) as Record<string, unknown>;
  return {
    ...doc,
    metadata: {
      ...metadata,
      name: NETWORK_POLICY_NAME,
      namespace,
      labels: { ...labels, "app.kubernetes.io/managed-by": "bandolier" },
    },
  };
}

// ── Raw-YAML validation (advanced repo config) ───────────────────────────────

/** "a.b.c/nn" CIDR check via node's IP parser (IPv4 /0-32, IPv6 /0-128). */
function isCidr(value: string): boolean {
  const [ip, prefix, rest] = value.split("/");
  if (!ip || prefix === undefined || rest !== undefined) return false;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const version = isIP(ip);
  if (version === 0) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

const cidrSchema = z
  .string()
  .refine(isCidr, "must be a CIDR like 10.0.0.0/8 or fd00::/8");

const labelSelectorSchema = z.strictObject({
  matchLabels: z.record(z.string(), z.string()).optional(),
  matchExpressions: z
    .array(
      z.strictObject({
        key: z.string().min(1),
        operator: z.enum(["In", "NotIn", "Exists", "DoesNotExist"]),
        values: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

const ipBlockSchema = z.strictObject({
  cidr: cidrSchema,
  except: z.array(cidrSchema).optional(),
});

// A NetworkPolicyPeer: exactly the shapes the API server accepts — an ipBlock,
// or pod/namespace selectors, never both, and never empty.
const peerSchema = z
  .strictObject({
    podSelector: labelSelectorSchema.optional(),
    namespaceSelector: labelSelectorSchema.optional(),
    ipBlock: ipBlockSchema.optional(),
  })
  .refine(
    (p) => !!p.podSelector || !!p.namespaceSelector || !!p.ipBlock,
    "peer must set podSelector, namespaceSelector, or ipBlock",
  )
  .refine(
    (p) => !(p.ipBlock && (p.podSelector ?? p.namespaceSelector)),
    "ipBlock cannot be combined with pod/namespace selectors",
  );

const portNumberSchema = z.int().min(1).max(65535);

const policyPortSchema = z
  .strictObject({
    protocol: z.enum(["TCP", "UDP", "SCTP"]).optional(),
    // A numeric port or a named container port.
    port: z.union([portNumberSchema, z.string().min(1)]).optional(),
    endPort: portNumberSchema.optional(),
  })
  .refine(
    (p) =>
      p.endPort === undefined ||
      (typeof p.port === "number" && p.port <= p.endPort),
    "endPort requires a numeric port that is not greater than it",
  );

const networkPolicySchema = z.strictObject({
  apiVersion: z.literal(
    "networking.k8s.io/v1",
    'apiVersion must be "networking.k8s.io/v1"',
  ),
  kind: z.literal("NetworkPolicy", 'kind must be "NetworkPolicy"'),
  // Name/namespace/labels here are tolerated but overridden at apply time —
  // the policy always lands as the managed one.
  metadata: z.looseObject({}).optional(),
  spec: z.strictObject({
    podSelector: labelSelectorSchema.refine(
      // A definitely-wrong selector ({app: something-else}) would silently
      // leave agent pods unpoliced (a policy that selects nothing restricts
      // nothing). Only reject the provably-wrong case; {} (all pods) and other
      // selectors are the admin's call.
      (s) =>
        s.matchLabels?.app === undefined ||
        s.matchLabels.app === "bandolier-agent",
      'agent pods are labelled app: "bandolier-agent" — this selector would never match them, leaving agents unrestricted',
    ),
    policyTypes: z.array(z.enum(["Ingress", "Egress"])).optional(),
    ingress: z
      .array(
        z.strictObject({
          from: z.array(peerSchema).optional(),
          ports: z.array(policyPortSchema).optional(),
        }),
      )
      .optional(),
    egress: z
      .array(
        z.strictObject({
          to: z.array(peerSchema).optional(),
          ports: z.array(policyPortSchema).optional(),
        }),
      )
      .optional(),
  }),
});

export type NetworkPolicyYamlValidation =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Validates a raw NetworkPolicy YAML document before it's saved as a repo's
 * custom agent policy: parseable single-document YAML whose structure is a
 * well-formed networking.k8s.io/v1 NetworkPolicy (unknown fields, bad
 * ports/CIDRs/selectors, and a podSelector that provably misses agent pods are
 * all rejected). metadata is not enforced — it's overridden at apply time.
 */
export function validateNetworkPolicyYaml(
  policyYaml: string,
): NetworkPolicyYamlValidation {
  let doc: unknown;
  try {
    doc = loadYaml(policyYaml);
  } catch (err) {
    return {
      valid: false,
      error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { valid: false, error: "YAML must be a single mapping document." };
  }

  const parsed = networkPolicySchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      )
      .join("; ");
    return { valid: false, error: `Not a valid NetworkPolicy: ${issues}` };
  }
  return { valid: true };
}
