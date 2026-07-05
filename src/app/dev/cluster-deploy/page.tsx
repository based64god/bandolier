"use client";

import { useState } from "react";

import { ClusterDeploySection } from "~/app/dashboard/_components/cluster-deploy-section";
import { api, type RouterOutputs } from "~/trpc/react";

/**
 * Dev-only harness that mounts ClusterDeploySection in isolation so the
 * one-click deploy wizard can be exercised in a real browser (Playwright).
 * Not linked from the app.
 *
 * The section fires tRPC queries on mount (clusterDeploy.status,
 * account.kubeconfigStatus, and clusterDeploy.adoptionBundle on success).
 * Rather than stand up a backend, each scenario primes the React Query cache
 * with fixtures before mounting; the mutations the section makes on its own
 * (start / tick / cancel / dismiss) are left for a spec to intercept.
 */
type Scenario = "form" | "form-overwrite" | "progress" | "done" | "failed";

type Deployment = NonNullable<RouterOutputs["clusterDeploy"]["status"]>;

const BASE_DEPLOYMENT: Deployment = {
  id: "dep-1",
  status: "waiting-cluster",
  error: null,
  clusterName: "bandolier-abc123",
  region: "nyc3",
  nodeSize: "s-4vcpu-8gb",
  minNodes: 1,
  maxNodes: 4,
  spacesEnabled: true,
  clusterId: "c-1111",
  bucketName: "bandolier-abc123-artifacts",
  spacesEndpoint: "https://nyc3.digitaloceanspaces.com",
  spacesAccessKeyId: "DO_SCOPED_KEY",
  spacesSecretAccessKey: null,
  createdAt: new Date(),
};

const DEPLOYMENTS: Record<Scenario, Deployment | null> = {
  form: null,
  "form-overwrite": null,
  progress: BASE_DEPLOYMENT,
  done: {
    ...BASE_DEPLOYMENT,
    status: "done",
    spacesSecretAccessKey: "scoped-secret-key",
  },
  failed: {
    ...BASE_DEPLOYMENT,
    status: "failed",
    error: 'Cluster entered state "errored" while provisioning.',
  },
};

const BUNDLE: RouterOutputs["clusterDeploy"]["adoptionBundle"] = {
  clusterName: "bandolier-abc123",
  importsTf: "import {\n  to = digitalocean_kubernetes_cluster.this\n}\n",
  tfvars: 'name = "bandolier-abc123"\n',
};

export default function ClusterDeployHarness() {
  const utils = api.useUtils();
  const [scenario, setScenario] = useState<Scenario | null>(null);

  // Prime the tRPC cache on the click (an event, not an effect) so the data is
  // in the cache before the section's mount queries run.
  const open = (id: Scenario) => {
    utils.clusterDeploy.status.setData(undefined, DEPLOYMENTS[id]);
    utils.clusterDeploy.adoptionBundle.setData(undefined, BUNDLE);
    utils.account.kubeconfigStatus.setData(undefined, {
      managedByRepo: false,
      configured: id === "form-overwrite",
    });
    setScenario(id);
  };

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const scenarios: Scenario[] = [
    "form",
    "form-overwrite",
    "progress",
    "done",
    "failed",
  ];

  return (
    <div className="min-h-screen space-y-4 bg-[#06140c] p-8 text-white">
      <h1 className="text-lg">ClusterDeploySection harness</h1>
      <div className="flex flex-wrap gap-2">
        {scenarios.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`open-${id}`}
            onClick={() => open(id)}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          >
            {id}
          </button>
        ))}
      </div>

      {scenario && (
        <div className="max-w-lg" key={scenario}>
          <ClusterDeploySection />
        </div>
      )}
    </div>
  );
}
