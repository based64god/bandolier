"use client";

import { useState, useSyncExternalStore } from "react";

import {
  ComputeForm,
  CredentialFeedback,
  MaskedCredentialRow,
  SecretForm,
  useCredentialMutations,
} from "~/app/dashboard/_components/credential-ui";
import { api } from "~/trpc/react";

// The infrastructure panel's sections: the user's own-cluster kubeconfig and
// the default agent compute limits. The one-click cluster deploy card renders
// alongside these but stays in dashboard/_components (it is exercised by the
// /dev/cluster-deploy page and tied to the deploy state machine).

export function KubeconfigSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.kubeconfigStatus.useQuery();
  const [kubeconfig, setKubeconfig] = useState("");
  const { result, setResult, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.kubeconfigStatus.invalidate(),
  );

  const save = api.account.setKubeconfig.useMutation({
    onSuccess: (r) =>
      onSave(
        () => setKubeconfig(""),
        `Saved and verified ✓ ${r.version ?? ""}`,
      ),
  });
  const test = api.account.testKubeconfig.useMutation({
    onSuccess: (r) =>
      setResult(r.valid ? `Valid ✓ ${r.version ?? ""}` : `Invalid: ${r.error}`),
  });
  const remove = api.account.deleteKubeconfig.useMutation({
    onSuccess: onRemove,
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-sky-300">Kubeconfig</h3>

      {status?.configured && (
        <MaskedCredentialRow
          onTest={() => {
            setResult("Testing…");
            test.mutate();
          }}
          testPending={test.isPending}
          onRemove={() => remove.mutate()}
          removePending={remove.isPending}
        >
          <span className="text-white/70">A kubeconfig is configured.</span>
        </MaskedCredentialRow>
      )}

      {!status?.configured && (
        <>
          <p className="text-xs text-white/40">
            Paste a kubeconfig to run your agents in your own cluster. It&apos;s
            verified against the cluster&apos;s API before saving.
          </p>

          <KubeconfigSetupHelp />

          <SecretForm
            accent="sky"
            variant="textarea"
            required
            value={kubeconfig}
            onChange={setKubeconfig}
            onSubmit={() => {
              setResult(null);
              save.mutate({ kubeconfig });
            }}
            rows={6}
            placeholder={
              "apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://…"
            }
            submitLabel="Save & verify"
            pendingLabel="Verifying…"
            pending={save.isPending}
            canSubmit={!!kubeconfig}
            align="end"
          />
        </>
      )}

      <CredentialFeedback saveError={save.error?.message} result={result} />
    </div>
  );
}

export function ComputeSection() {
  const utils = api.useUtils();
  const { data: status } = api.account.computeStatus.useQuery();
  const save = api.account.setCompute.useMutation({
    onSuccess: () => {
      void utils.account.computeStatus.invalidate();
      void utils.agents.deployDefaults.invalidate();
    },
  });

  return (
    <ComputeForm
      accent="emerald"
      containerClassName="space-y-3"
      title="Agent compute"
      titleClassName="text-sm font-semibold text-emerald-300"
      description={
        <>
          Default CPU / memory limit for the agents you deploy, as Kubernetes
          quantities (e.g. <code className="text-white/60">4</code> CPUs,{" "}
          <code className="text-white/60">8Gi</code> memory). A repository can
          set its own default, and each task can override both. Blank = the
          built-in limit.
        </>
      }
      values={{ cpu: status?.cpu, memory: status?.memory }}
      onSave={(compute) => save.mutateAsync(compute)}
      pending={save.isPending}
      error={save.error?.message}
    />
  );
}

function KubeconfigSetupHelp() {
  const [copied, setCopied] = useState(false);

  // Resolve the real host on the client so the command is ready to paste.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "https://<your-host>",
  );

  const command = `curl -fsSL ${origin}/setup.sh | bash`;

  return (
    <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2.5">
      <p className="text-xs text-white/50">
        Bandolier runs the Kubernetes client on its server, so it needs a
        self-contained, token-based kubeconfig — not one that shells out to{" "}
        <code className="text-white/60">aws</code>/
        <code className="text-white/60">gcloud</code> or references local cert
        files. Run this against your cluster (you need{" "}
        <code className="text-white/60">kubectl</code> admin access) to
        provision a ServiceAccount and print a kubeconfig you can paste below:
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-sky-200">
          {command}
        </code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="text-xs text-white/40">
        Add <code className="text-white/60">| bash -s -- --scoped</code> to bind
        a least-privilege role instead of cluster-admin, or{" "}
        <code className="text-white/60">--help</code> for more options.
      </p>
    </div>
  );
}
