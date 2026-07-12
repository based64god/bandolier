"use client";

import { useState } from "react";

import { CredentialFeedback } from "./credential-ui";

// The credential form for a single gollm-proxied (catalog) provider — the card
// body used in the provider directory. Its shape is bespoke per provider: it
// renders exactly the fields the provider declared (a bare API key for Groq, an
// endpoint + optional key for a self-hosted vLLM, a PEM plus identity fields for
// OCI, …), each with its own label and input type. When already configured it
// shows the masked summary + Remove. Scope-agnostic: the caller injects the
// save/remove callbacks (account router for the user, webhooks for a repo).

export interface CatalogField {
  env: string;
  label: string;
  placeholder: string | null;
  kind: "secret" | "text" | "textarea";
  optional: boolean;
  hint: string | null;
}

export interface CatalogEntry {
  id: string;
  label: string;
  listable: boolean;
  hint: string | null;
  fields: CatalogField[];
}

export interface ConfiguredProvider {
  provider: string;
  label: string;
  apiKeyMasked: string | null;
  apiBase: string | null;
  extraEnvKeys: string[];
  models: string[];
}

export interface CustomProviderFormValues {
  /** Field env var → entered value. */
  fields: Record<string, string>;
  models: string;
}

const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-sky-400/60 focus:outline-none";

export function GenericProviderForm({
  entry,
  configured,
  onSubmit,
  savePending,
  saveError,
  result,
  onTest,
  testPending,
  onRemove,
  removePending,
}: {
  entry: CatalogEntry;
  configured?: ConfiguredProvider;
  /** Persist this provider; the form clears when the promise resolves. */
  onSubmit: (values: CustomProviderFormValues) => Promise<void>;
  savePending: boolean;
  saveError?: string | null;
  result: string | null;
  /** Live-test the stored credential (omit to hide the Test button). */
  onTest?: () => void;
  testPending?: boolean;
  onRemove: () => void;
  removePending: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [models, setModels] = useState("");

  const setField = (env: string, v: string) =>
    setValues((prev) => ({ ...prev, [env]: v }));

  const canSubmit = entry.fields.every(
    (f) => f.optional || !!values[f.env]?.trim(),
  );

  if (configured) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 font-mono text-xs text-white/50">
            {configured.apiKeyMasked ?? "(no key)"}
            {configured.apiBase ? ` · ${configured.apiBase}` : ""}
            {configured.models.length > 0
              ? ` · ${configured.models.length} model(s)`
              : ""}
            {configured.extraEnvKeys.length > 0
              ? ` · +${configured.extraEnvKeys.join(", ")}`
              : ""}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onTest && (
              <button
                type="button"
                onClick={onTest}
                disabled={testPending}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:bg-white/5 disabled:opacity-50"
              >
                Test
              </button>
            )}
            <button
              type="button"
              onClick={onRemove}
              disabled={removePending}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:bg-white/5 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
        <CredentialFeedback result={result} saveError={saveError} />
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ fields: values, models }).then(
          () => {
            setValues({});
            setModels("");
          },
          () => undefined,
        );
      }}
      className="space-y-2"
    >
      {entry.fields.map((field) => {
        const label = field.optional
          ? `${field.label} (optional)`
          : field.label;
        const placeholder = field.placeholder ?? label;
        return (
          <div key={field.env} className="space-y-1">
            {field.kind === "textarea" ? (
              <textarea
                rows={3}
                value={values[field.env] ?? ""}
                onChange={(e) => setField(field.env, e.target.value)}
                placeholder={placeholder}
                className={`${inputClass} font-mono text-xs`}
              />
            ) : (
              <input
                type={field.kind === "secret" ? "password" : "text"}
                value={values[field.env] ?? ""}
                onChange={(e) => setField(field.env, e.target.value)}
                placeholder={placeholder}
                className={inputClass}
              />
            )}
            {field.hint && (
              <p className="text-xs text-white/40">{field.hint}</p>
            )}
          </div>
        );
      })}

      {!entry.listable && (
        <input
          type="text"
          value={models}
          onChange={(e) => setModels(e.target.value)}
          placeholder="Model ids (comma-separated) — no model-list API"
          className={inputClass}
        />
      )}

      {entry.hint && <p className="text-xs text-white/40">{entry.hint}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={savePending || !canSubmit}
          className="rounded-lg bg-sky-500/20 px-3 py-2 text-sm font-medium text-sky-200 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {savePending ? "Verifying…" : "Save"}
        </button>
      </div>
      <CredentialFeedback result={result} saveError={saveError} />
    </form>
  );
}
