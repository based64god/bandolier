"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

// Owns the `result` string and the invalidate/clear/message dance that every
// credential section repeated in its save & remove mutations. Pass the scope's
// cache-invalidation callback; wire the returned `onSave`/`onRemove` into the
// mutations' `onSuccess`, and render `result` through `CredentialFeedback`.
export function useCredentialMutations(invalidate: () => Promise<unknown>) {
  const [result, setResult] = useState<string | null>(null);
  const onSave = (clear?: () => void, message = "Saved and verified ✓") => {
    void invalidate();
    clear?.();
    setResult(message);
  };
  const onRemove = () => {
    void invalidate();
    setResult(null);
  };
  return { result, setResult, onSave, onRemove };
}

// Shared building blocks for the credential sections that appear both
// user-scoped (SettingsModal) and repo-scoped (RepoConfigModal). Before this,
// every provider section duplicated the same masked-row / input-form / feedback
// markup twice over; these primitives are the single source of truth.

type Accent = "purple" | "teal" | "blue" | "orange" | "sky" | "emerald";

const ACCENTS: Record<Accent, { focus: string; button: string }> = {
  purple: {
    focus: "focus:border-purple-500/50",
    button: "bg-purple-600 text-black hover:bg-purple-500",
  },
  teal: {
    focus: "focus:border-teal-500/50",
    button: "bg-teal-600 hover:bg-teal-500",
  },
  blue: {
    focus: "focus:border-blue-500/50",
    button: "bg-blue-600 text-black hover:bg-blue-500",
  },
  orange: {
    focus: "focus:border-orange-500/50",
    button: "bg-orange-600 hover:bg-orange-500",
  },
  sky: {
    focus: "focus:border-sky-500/50",
    button: "bg-sky-600 text-black hover:bg-sky-500",
  },
  emerald: {
    focus: "focus:border-emerald-500/50",
    button: "bg-emerald-600 text-black hover:bg-emerald-500",
  },
};

// Inline result banner. `saveError` (a mutation error) always wins and renders
// red; otherwise a `result` string starting with "Invalid" is treated as an
// error, and anything else as a success. This is the split every credential
// section used to inline by hand.
export function CredentialFeedback({
  saveError,
  result,
}: {
  saveError?: string | null;
  result?: string | null;
}) {
  const invalid = result?.startsWith("Invalid") ?? false;
  const error = saveError ?? (invalid ? result : null);
  const ok = !invalid ? (result ?? null) : null;
  if (!error && !ok) return null;
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-xs ${
        error
          ? "border-red-500/30 bg-red-500/10 text-red-400"
          : "border-green-500/30 bg-green-500/10 text-green-300"
      }`}
    >
      {error ?? ok}
    </p>
  );
}

// A configured-credential row: caller-supplied masked display on the left, an
// optional Test button, and a Remove button on the right.
export function MaskedCredentialRow({
  children,
  onTest,
  testPending,
  onRemove,
  removePending,
}: {
  children: ReactNode;
  onTest?: () => void;
  testPending?: boolean;
  onRemove: () => void;
  removePending?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm">
      {children}
      <div className="flex shrink-0 items-center gap-2">
        {onTest && (
          <button
            onClick={onTest}
            disabled={testPending}
            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
          >
            Test
          </button>
        )}
        <button
          onClick={onRemove}
          disabled={removePending}
          className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// A single-secret entry form. `variant="input"` is the inline password field +
// button; `variant="textarea"` is a multi-line field with the button below
// (right-aligned when `align="end"`). `children` renders before the field for
// per-provider help text.
export function SecretForm({
  accent,
  variant = "input",
  value,
  onChange,
  onSubmit,
  placeholder,
  inputType = "password",
  rows,
  required,
  submitLabel,
  pendingLabel,
  pending,
  canSubmit,
  align,
  children,
}: {
  accent: Accent;
  variant?: "input" | "textarea";
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  inputType?: "password" | "text";
  rows?: number;
  required?: boolean;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  canSubmit: boolean;
  align?: "end";
  children?: ReactNode;
}) {
  const a = ACCENTS[accent];
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const button = (
    <button
      type="submit"
      disabled={pending || !canSubmit}
      className={`rounded-lg px-3 py-2 text-sm font-medium ${a.button} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {pending ? pendingLabel : submitLabel}
    </button>
  );

  if (variant === "input") {
    return (
      <form onSubmit={handleSubmit} className="flex gap-2">
        {children}
        <input
          type={inputType}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 ${a.focus} focus:outline-none`}
        />
        {button}
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {children}
      <textarea
        required={required}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white placeholder-white/25 ${a.focus} focus:outline-none`}
      />
      {align === "end" ? (
        <div className="flex justify-end">{button}</div>
      ) : (
        button
      )}
    </form>
  );
}

// A labelled on/off pill switch inside a bordered card. Generalized from the
// per-repo network-policy toggle so config toggles are a few lines of props.
export function ToggleSection({
  label,
  description,
  enabled,
  disabled,
  onChange,
  accent = "amber",
  switchAriaLabel,
}: {
  label: string;
  description: ReactNode;
  enabled: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  accent?: "amber" | "purple";
  switchAriaLabel?: string;
}) {
  const onBg = accent === "purple" ? "bg-purple-500/70" : "bg-amber-500/70";
  return (
    <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h4 className="text-xs font-semibold text-white/70">{label}</h4>
          <p className="text-[11px] text-white/40">{description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={switchAriaLabel ?? label}
          onClick={() => onChange(!enabled)}
          disabled={disabled}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? onBg : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
