"use client";

import { useState } from "react";

import { SearchableSelect } from "~/app/dashboard/_components/searchable-select";

/**
 * Dev-only harness that mounts SearchableSelect in isolation (no tRPC/auth), so
 * the dropdown's keyboard UX can be exercised in a real browser — e.g. with
 * Playwright. Not linked from the app. The selected value is echoed below so a
 * test can assert what arrow-key navigation + Enter resolves to.
 */
export default function SearchableSelectHarness() {
  const [value, setValue] = useState<string | null>("beta");

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  const options = ["alpha", "beta", "gamma", "delta", "epsilon"].map(
    (name) => ({
      value: name,
      searchText: name,
      label: <span>{name}</span>,
    }),
  );

  return (
    <div className="min-h-screen bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">SearchableSelect harness</h1>
      <div className="max-w-md">
        <SearchableSelect
          options={options}
          value={value}
          onChange={setValue}
          placeholder="Select an option"
          searchPlaceholder="Search…"
          clearLabel="None"
        />
      </div>
      <p data-testid="value" className="mt-4 font-mono text-sm">
        {value ?? "null"}
      </p>
    </div>
  );
}
