"use client";

import { useState } from "react";

import {
  ComputeForm,
  CredentialFeedback,
  MaskedCredentialRow,
  SecretForm,
  ToggleSection,
} from "~/app/dashboard/_components/credential-ui";

/**
 * Dev-only harness that mounts the shared credential building blocks in
 * isolation (no tRPC/auth), so the masked row, secret form, feedback banner,
 * and toggle can be exercised in a real browser — e.g. with Playwright. Not
 * linked from the app. Interactions are echoed below so a test can assert them.
 */
export default function CredentialUiHarness() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [toggle, setToggle] = useState(false);
  const [compute, setCompute] = useState<string | null>(null);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  return (
    <div className="min-h-screen space-y-4 bg-[#06140c] p-8 text-white">
      <h1 className="text-lg">Credential UI harness</h1>
      <div className="max-w-lg space-y-4">
        {saved ? (
          <MaskedCredentialRow
            onRemove={() => {
              setRemoved(true);
              setSaved(null);
            }}
          >
            <code className="text-purple-300" data-testid="masked">
              {saved}
            </code>
          </MaskedCredentialRow>
        ) : (
          <SecretForm
            accent="purple"
            value={value}
            onChange={setValue}
            onSubmit={() => setSaved(value)}
            placeholder="secret"
            submitLabel="Save"
            pendingLabel="Verifying…"
            pending={false}
            canSubmit={!!value}
          />
        )}

        <CredentialFeedback result={saved ? "Saved and verified ✓" : null} />

        <ToggleSection
          label="A toggle"
          description="Flip me"
          enabled={toggle}
          disabled={false}
          onChange={setToggle}
        />

        <ComputeForm
          accent="emerald"
          containerClassName="space-y-3 border-t border-white/10 pt-6"
          title="Agent compute"
          titleClassName="text-sm font-semibold text-emerald-300"
          description="CPU / memory limits"
          values={{}}
          onSave={(c) => {
            setCompute(`${c.cpu}/${c.memory}`);
            return Promise.resolve();
          }}
          pending={false}
        />
      </div>

      <p data-testid="removed" className="font-mono text-sm">
        {removed ? "removed" : "present"}
      </p>
      <p data-testid="toggle" className="font-mono text-sm">
        {toggle ? "on" : "off"}
      </p>
      <p data-testid="compute" className="font-mono text-sm">
        {compute ?? "unset"}
      </p>
    </div>
  );
}
