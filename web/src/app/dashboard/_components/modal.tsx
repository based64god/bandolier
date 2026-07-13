"use client";

import { useEffect, useRef } from "react";

// Shared shell for the dashboard's modals. Owns the behavior that used to be
// copy-pasted (and had drifted) across each modal: the backdrop, the Escape
// handler, locking background scroll while open, and closing only when the
// mouse gesture both started and ended on the backdrop — so a text-selection
// drag that ends outside the panel doesn't dismiss the modal.
//
// The header (title, optional accessory beside it, optional right-side actions,
// and the red ✕ close button) is rendered here too; each modal supplies only its
// content and any header extras via slots.
export function Modal({
  onClose,
  title,
  titleAccessory,
  headerActions,
  headerClassName = "flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3",
  panelClassName = "flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-white/20 bg-[var(--surface-panel)]",
  children,
}: {
  onClose: () => void;
  title?: React.ReactNode;
  // Rendered next to the title on the left of the header (e.g. a provider badge
  // or a repo/pod chip).
  titleAccessory?: React.ReactNode;
  // Rendered on the right of the header, before the close button.
  headerActions?: React.ReactNode;
  headerClassName?: string;
  panelClassName?: string;
  children: React.ReactNode;
}) {
  // Tracks whether the current mouse gesture began on the backdrop, so a drag
  // that ends outside the panel doesn't count as a backdrop click.
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Lock background scrolling while the modal is open so only the panel scrolls.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div
      // Keep the panel clear of the physical display edges. Under
      // viewport-fit=cover (see layout.tsx) this fixed overlay spans edge-to-edge
      // — past the safe-area insets padded onto <body> — so pad each side by at
      // least 1rem but never less than that side's inset, otherwise the panel's
      // rounded border clips under the notch / Dynamic Island / home indicator on
      // iPhones. Devices reporting zero insets resolve to 1rem, identical to the
      // old p-4.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur-sm"
      onMouseDown={(e) => {
        backdropMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current)
          onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={panelClassName}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={headerClassName}>
          <div className="flex min-w-0 items-center gap-3">
            {title != null && (
              <h2 className="text-sm font-semibold text-white">{title}</h2>
            )}
            {titleAccessory}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {headerActions}
            <button
              onClick={onClose}
              className="rounded p-1 text-red-500 hover:bg-red-500/10 hover:text-red-300"
              aria-label="Close"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-5 w-5">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
