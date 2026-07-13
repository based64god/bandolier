"use client";

import { useRef, useState } from "react";

import { api } from "~/trpc/react";
import {
  CredentialFeedback,
  ToggleSection,
} from "~/app/dashboard/_components/credential-ui";

// Per-repo network-policy egress toggles. Both loosen the default agent
// NetworkPolicy (deny inbound; egress only to DNS + the public internet on
// 80/443, with in-cluster private ranges blocked) and are OFF by default.
// Enabling either trades isolation for reach, so a prominent security warning
// sits above the toggles. Admin-only (the whole page is gated server-side).
export function RepoNetworkPolicySection({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const utils = api.useUtils();
  const { data: config, isLoading } = api.webhooks.getConfig.useQuery({
    repoFullName,
  });
  const setPolicy = api.webhooks.setNetworkPolicy.useMutation({
    onSuccess: () => utils.webhooks.getConfig.invalidate({ repoFullName }),
  });

  // Advanced: raw NetworkPolicy YAML replacing the built-in policy (and the
  // toggles) entirely. Uncontrolled like the other config fields — the key
  // remounts it when a save changes updatedAt.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [yamlResult, setYamlResult] = useState<string | null>(null);
  const yamlRef = useRef<HTMLTextAreaElement>(null);
  const setPolicyYaml = api.webhooks.setNetworkPolicyYaml.useMutation({
    onSuccess: (_data, variables) => {
      void utils.webhooks.getConfig.invalidate({ repoFullName });
      setYamlResult(
        variables.yaml.trim()
          ? "Validated and saved ✓"
          : "Custom policy removed — back to the built-in policy.",
      );
    },
  });

  const allowPrivate = config?.allowPrivateEgress ?? false;
  const allowAllPorts = config?.allowAllPortsEgress ?? false;
  const hasCustomYaml = !!config?.networkPolicyYaml;
  const advancedVisible = showAdvanced || hasCustomYaml;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-amber-300">
          Network policy egress
        </h3>
        <p className="text-xs text-white/40">
          By default this repo&apos;s agent pods are locked down: all inbound
          traffic is denied and egress is limited to DNS and the public internet
          over HTTP(S), with in-cluster private ranges blocked. These toggles
          loosen that per repo. They only take effect when{" "}
          <code className="rounded bg-white/10 px-1 text-white/60">
            AGENT_NETWORK_POLICY
          </code>{" "}
          is enabled and the cluster runs a policy-enforcing CNI
          (Calico/Cilium).
        </p>
      </div>

      {/* Security warning — loosening egress weakens pod isolation. */}
      <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
        <span aria-hidden className="text-amber-300">
          ⚠
        </span>
        <p className="text-xs text-amber-200/90">
          <span className="font-semibold">
            Loosening egress weakens agent isolation — enable only when you
            trust the workloads this repo runs.
          </span>{" "}
          Agents run model-generated code with your credentials. Allowing
          in-cluster egress opens lateral movement to other pods and internal
          services; allowing all ports widens what an agent can connect to and
          exfiltrate over. Leave these off unless a specific task needs them,
          and turn them back off when it&apos;s done.
        </p>
      </div>

      {isLoading ? (
        <p className="text-xs text-white/30">Loading…</p>
      ) : (
        <div className="space-y-2">
          <ToggleSection
            label="Allow in-cluster (private) egress"
            description="Drop the block on RFC-1918 ranges so agents can reach other pods and in-cluster services. Lateral-movement risk."
            enabled={allowPrivate}
            disabled={setPolicy.isPending || hasCustomYaml}
            onChange={(v) =>
              setPolicy.mutate({ repoFullName, allowPrivateEgress: v })
            }
          />
          <ToggleSection
            label="Allow all egress ports"
            description="Permit outbound TCP on any port instead of only 80/443. Widens the exfiltration / arbitrary-protocol surface."
            enabled={allowAllPorts}
            disabled={setPolicy.isPending || hasCustomYaml}
            onChange={(v) =>
              setPolicy.mutate({ repoFullName, allowAllPortsEgress: v })
            }
          />
          {hasCustomYaml && (
            <p className="text-[11px] text-amber-300/80">
              A custom policy is active — these toggles are ignored until it is
              removed.
            </p>
          )}
          {setPolicy.error && (
            <p className="text-xs text-red-400">{setPolicy.error.message}</p>
          )}

          {/* Advanced: raw NetworkPolicy YAML. */}
          {!advancedVisible ? (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="text-xs text-white/40 hover:text-white/70"
            >
              ▸ Advanced: edit the raw NetworkPolicy YAML
            </button>
          ) : (
            <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-white/70">
                  Advanced: raw NetworkPolicy YAML
                  {hasCustomYaml && (
                    <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-normal text-amber-300/80">
                      custom policy active
                    </span>
                  )}
                </h4>
                {!hasCustomYaml && (
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(false)}
                    className="text-xs text-white/40 hover:text-white/70"
                  >
                    ▾ Hide
                  </button>
                )}
              </div>
              <p className="text-[11px] text-white/40">
                The exact policy applied to this repo&apos;s agent namespaces,
                replacing the toggles above entirely. Validated when saved. Keep
                a podSelector that matches the agent pods (
                <code className="rounded bg-white/10 px-1 text-white/60">
                  app: bandolier-agent
                </code>
                ); the policy&apos;s name and namespace are managed by Bandolier
                and overridden on apply.
              </p>
              <textarea
                key={
                  config
                    ? `netpol-yaml-${String(config.updatedAt)}`
                    : "netpol-yaml-loading"
                }
                ref={yamlRef}
                rows={14}
                spellCheck={false}
                defaultValue={
                  hasCustomYaml && config
                    ? config.networkPolicyYaml
                    : (config?.defaultNetworkPolicyYaml ?? "")
                }
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre text-white placeholder-white/25 focus:border-amber-500/50 focus:outline-none"
              />
              <div className="flex items-center justify-end gap-2">
                {hasCustomYaml && (
                  <button
                    type="button"
                    disabled={setPolicyYaml.isPending}
                    onClick={() => {
                      setYamlResult(null);
                      setPolicyYaml.mutate({ repoFullName, yaml: "" });
                    }}
                    className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    Remove custom policy
                  </button>
                )}
                <button
                  type="button"
                  disabled={setPolicyYaml.isPending}
                  onClick={() => {
                    setYamlResult(null);
                    setPolicyYaml.mutate({
                      repoFullName,
                      yaml: yamlRef.current?.value ?? "",
                    });
                  }}
                  className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-black hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {setPolicyYaml.isPending
                    ? "Validating…"
                    : "Validate & save custom policy"}
                </button>
              </div>
              <CredentialFeedback
                saveError={setPolicyYaml.error?.message}
                result={yamlResult}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
