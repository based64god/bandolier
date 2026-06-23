// Pure helpers backing the slash-command typeahead in the interactive session
// input (see InteractiveRow). Kept free of React so the matching/parsing rules
// can be unit tested in isolation — the component is a thin shell over these.
//
// Native Claude Code populates its slash-command menu dynamically from the
// agent's ACP `available_commands_update` notification. The harness forwards
// that frame (acp_agent.go derives it from claude's stream-json init event),
// and useAcpSession surfaces it as `commands`; resolveSlashCommands below feeds
// it into the menu, falling back to DEFAULT_SLASH_COMMANDS until one arrives
// (e.g. for the codex provider, which reports no command set).

export interface SlashCommand {
  /** Command name without the leading slash, e.g. "code-review". */
  name: string;
  /** One-line summary shown beside the name in the menu. */
  description: string;
}

/**
 * Curated default commands: Claude Code built-ins that make sense mid-session
 * plus this repo's skills. Replaceable by a live ACP-sourced list later.
 */
export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  { name: "code-review", description: "Review the current diff for bugs" },
  {
    name: "security-review",
    description: "Security review of pending changes",
  },
  { name: "review", description: "Review a GitHub pull request" },
  { name: "simplify", description: "Clean up the changed code" },
  { name: "verify", description: "Run the app and confirm a change works" },
  { name: "init", description: "Generate a CLAUDE.md for this repo" },
  { name: "compact", description: "Summarize the conversation so far" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "neon-postgres", description: "Neon Serverless Postgres guidance" },
];

/**
 * Picks the command list to show: the agent's live list when it has advertised
 * one (via ACP available_commands_update), otherwise the curated defaults. The
 * claude CLI reports command names without descriptions, so each live command
 * borrows the matching default's description when its own is empty — the menu
 * stays informative without the harness having to source descriptions.
 */
export function resolveSlashCommands(
  live: { name: string; description?: string }[] | undefined,
): SlashCommand[] {
  if (!live || live.length === 0) return DEFAULT_SLASH_COMMANDS;
  const descriptions = new Map(
    DEFAULT_SLASH_COMMANDS.map((c) => [c.name, c.description]),
  );
  return live.map((c) => {
    // The agent's own description wins; an empty/absent one borrows the
    // matching default's blurb, else stays empty.
    const own = c.description?.trim();
    return { name: c.name, description: own ?? descriptions.get(c.name) ?? "" };
  });
}

/**
 * Returns the active command query when the slash menu should be open, or null
 * when it should be closed. The menu opens only while the draft is a single
 * `/`-prefixed token with no whitespace yet — i.e. the user is still typing the
 * command name. The first space starts the arguments, which closes the menu
 * (matching native Claude Code), and leading whitespace or any non-slash start
 * means it isn't a command at all.
 *
 * `/`        → ""        (just opened, show everything)
 * `/cod`     → "cod"     (filtering)
 * `/code rev`→ null      (typing args)
 * `hi /code` → null      (not at the start)
 * ``         → null
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/**
 * Filters commands by a case-insensitive prefix match on the name, preserving
 * the source order. An empty query (bare `/`) returns the whole list.
 */
export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * The draft after choosing a command: `/name ` with a trailing space, ready for
 * the user to type arguments (or send as-is). The trailing space also closes
 * the menu, since slashQuery treats whitespace as the start of arguments.
 */
export function applySlashCommand(name: string): string {
  return `/${name} `;
}
