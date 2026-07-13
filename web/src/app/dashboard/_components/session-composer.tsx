"use client";

import { useEffect, useRef, useState } from "react";

import type { AvailableCommand } from "~/lib/acp/timeline";
import {
  applySlashCommand,
  filterSlashCommands,
  resolveSlashCommands,
  slashQuery,
  type SlashCommand,
} from "./slash-commands";

/**
 * Message input for an interactive session: the textarea, Send button, and the
 * native-Claude-Code-style slash-command typeahead. Split out from
 * InteractiveRow so the command UX is a self-contained, independently testable
 * unit (it has no tRPC/ACP dependencies — the row owns those and passes the
 * advertised `commands` and a plain `onSend`).
 */
export function SessionComposer({
  running,
  awaiting,
  ready,
  sendPending,
  sendError,
  commands,
  onSend,
  focusSignal,
}: {
  running: boolean;
  awaiting: boolean;
  /** True once a prompt can actually be sent (session id known). */
  ready: boolean;
  sendPending: boolean;
  sendError: string | null;
  /** Slash commands the agent advertised (ACP available_commands_update). */
  commands: AvailableCommand[];
  onSend: (content: string) => void;
  /**
   * Bumped by the parent to imperatively move keyboard focus into this
   * textarea — used when Tab cycles through the sessions awaiting input so the
   * user lands ready to type. Each new value (re)focuses; `null`/`0` is inert.
   */
  focusSignal?: number | null;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Move keyboard focus into the textarea whenever the parent bumps the signal.
  // preventScroll is essential: the row's reveal has already scrolled the
  // session to the top of the viewport (interactive controls at the top,
  // composer at the bottom), and a plain focus() would scroll the textarea back
  // into view from the bottom, dragging the row up and off the top. The effect
  // also runs on mount, so a request that first expands a collapsed row still
  // lands focus once the textarea renders.
  useEffect(() => {
    if (!focusSignal) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);
  // Index of the arrow-key-highlighted command in the slash menu.
  const [cmdHighlight, setCmdHighlight] = useState(0);

  // Slash-command typeahead. The menu opens while the draft is a single
  // `/`-prefixed token (see slashQuery) and filters by prefix as the user types.
  // The list is the agent's advertised commands when present, falling back to
  // curated defaults until one arrives.
  const availableCommands = resolveSlashCommands(commands);
  const query = slashQuery(draft);
  const commandMatches: SlashCommand[] =
    query === null ? [] : filterSlashCommands(availableCommands, query);
  const menuOpen = running && commandMatches.length > 0;
  // Clamp at render time rather than in an effect: as matches narrow (the user
  // types more letters) the stored index can fall out of range, and clamping
  // here avoids a cascading setState-in-effect render.
  const activeHighlight = Math.min(
    cmdHighlight,
    Math.max(0, commandMatches.length - 1),
  );

  function chooseCommand(name: string) {
    setDraft(applySlashCommand(name));
    setCmdHighlight(0);
  }

  function send() {
    const content = draft.trim();
    if (!content || !ready || sendPending) return;
    onSend(content);
    setDraft("");
  }

  return (
    <div className="border-t border-white/10 p-3">
      <div className="relative flex items-end gap-2">
        {menuOpen && (
          <SlashCommandMenu
            commands={commandMatches}
            highlight={activeHighlight}
            onHighlight={setCmdHighlight}
            onChoose={chooseCommand}
          />
        )}
        <textarea
          ref={textareaRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // While the slash menu is open, arrow keys / Tab / Enter drive the
            // menu instead of editing or sending; Escape closes it but keeps the
            // typed text (minus the leading slash) as an ordinary message.
            if (menuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCmdHighlight(
                  Math.min(commandMatches.length - 1, activeHighlight + 1),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCmdHighlight(Math.max(0, activeHighlight - 1));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                // Stop Tab here so the table's tab-to-cycle handler (which this
                // bubbles up to) doesn't also jump to another session while the
                // user is picking a slash command.
                e.stopPropagation();
                const pick = commandMatches[activeHighlight];
                if (pick) chooseCommand(pick.name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft((d) => d.replace(/^\//, ""));
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={!running}
          placeholder={
            running
              ? awaiting
                ? "The agent is waiting — type a message and press Enter…"
                : "Send a message (the agent will pick it up after its current turn)…"
              : "Session ended."
          }
          // min-w-0 lets the textarea shrink below its intrinsic width so the
          // auto-layout table can't be forced wider than the viewport (which
          // overflowed and shifted columns on mobile).
          className="min-h-0 w-0 min-w-0 flex-1 resize-y rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 focus:outline-none disabled:opacity-40"
        />
        <button
          onClick={send}
          disabled={!running || !draft.trim() || !ready || sendPending}
          className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-black hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sendPending ? "Sending…" : "Send"}
        </button>
      </div>
      {sendError && <p className="mt-1.5 text-xs text-red-400">{sendError}</p>}
    </div>
  );
}

/**
 * Typeahead popup for slash commands, anchored above the message input (it opens
 * upward so it never pushes the textarea or covers the conversation). Mirrors
 * native Claude Code: filtered command list, arrow-key highlight, click or
 * Enter/Tab to choose. Keyboard navigation lives in the textarea's onKeyDown so
 * focus stays in the input as the user types; this component renders the list
 * and handles mouse interaction.
 */
function SlashCommandMenu({
  commands,
  highlight,
  onHighlight,
  onChoose,
}: {
  commands: SlashCommand[];
  highlight: number;
  onHighlight: (index: number) => void;
  onChoose: (name: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the arrow-key-highlighted command scrolled into view as it moves past
  // the fold (the list can be taller than max-h-60). Mirrors SearchableSelect.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-nav="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-20 mb-2 max-h-60 w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-white/10 bg-[var(--surface-panel)] py-1 shadow-2xl"
    >
      {commands.map((c, i) => {
        const isHighlighted = i === highlight;
        return (
          <button
            key={c.name}
            type="button"
            role="option"
            data-nav={i}
            aria-selected={isHighlighted}
            // onMouseDown (not onClick) so the choice registers before the
            // textarea's blur, keeping focus in the input after selection.
            onMouseDown={(e) => {
              e.preventDefault();
              onChoose(c.name);
            }}
            onMouseEnter={() => onHighlight(i)}
            className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition ${
              isHighlighted ? "bg-purple-600/40" : ""
            }`}
          >
            <span className="font-mono text-sm text-white/90">/{c.name}</span>
            {c.description && (
              <span className="text-xs text-white/40">{c.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
