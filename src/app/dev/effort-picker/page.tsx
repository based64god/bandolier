"use client";

import { useState } from "react";

import { EffortPicker } from "~/app/dashboard/_components/effort-picker";

/**
 * Dev-only harness that mounts EffortPicker in isolation (no tRPC/auth), so the
 * dropdown and the "Preferred" toggle can be exercised in a real browser — e.g.
 * with Playwright. Not linked from the app. The selected level and preferred
 * flag are echoed below so a test can assert what each selection resolves to.
 */
export default function EffortPickerHarness() {
  const [value, setValue] = useState("");
  const [preferred, setPreferred] = useState("");

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const isPreferred = !!value && value === preferred;

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">EffortPicker harness</h1>
      <div className="max-w-lg">
        <EffortPicker
          value={value}
          onChange={setValue}
          preferred
          isPreferred={isPreferred}
          onTogglePreferred={(next) => setPreferred(next ? value : "")}
        />
      </div>
      <p data-testid="value" className="mt-4 font-mono text-sm">
        {value || "default"}
      </p>
      <p data-testid="preferred" className="mt-1 font-mono text-sm">
        {preferred || "none"}
      </p>
    </div>
  );
}
