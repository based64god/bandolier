"use client";

import { useState } from "react";

import { Modal } from "~/app/dashboard/_components/modal";

/**
 * Dev-only harness that mounts the shared Modal in isolation (no tRPC/auth), so
 * its shell behavior — Escape to close, backdrop-click to close, and NOT closing
 * when a drag starts inside the panel and ends on the backdrop, plus body
 * scroll-lock — can be exercised in a real browser with Playwright. Not linked
 * from the app. A close counter is echoed below so a test can assert whether a
 * gesture triggered onClose.
 */
export default function ModalHarness() {
  const [open, setOpen] = useState(true);
  const [closes, setCloses] = useState(0);

  // Dev/test only — never expose this route in a deployed app.
  if (process.env.NODE_ENV === "production") {
    return <p className="p-8 text-white">Not available.</p>;
  }

  return (
    <div className="min-h-[300vh] bg-[#06140c] p-8 text-white">
      <h1 className="mb-4 text-lg">Modal harness</h1>
      <button
        data-testid="open"
        onClick={() => setOpen(true)}
        className="rounded bg-purple-600 px-3 py-1.5 text-sm text-black"
      >
        Open
      </button>
      <p data-testid="closes" className="mt-4 font-mono text-sm">
        {closes}
      </p>
      <p data-testid="body-overflow" className="mt-2 font-mono text-sm">
        {open ? "open" : "closed"}
      </p>

      {open && (
        <Modal
          onClose={() => {
            setCloses((c) => c + 1);
            setOpen(false);
          }}
          title="Test Modal"
        >
          <div className="px-4 py-3">
            <p data-testid="panel-text" className="text-sm text-white/70">
              Select this long line of text by dragging across it and releasing
              outside the panel — the modal must stay open.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
