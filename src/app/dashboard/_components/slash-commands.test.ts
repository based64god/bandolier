import { describe, expect, it } from "vitest";

import {
  applySlashCommand,
  DEFAULT_SLASH_COMMANDS,
  filterSlashCommands,
  resolveSlashCommands,
  slashQuery,
  type SlashCommand,
} from "~/app/dashboard/_components/slash-commands";

describe("slashQuery", () => {
  it("opens with an empty query on a bare slash", () => {
    expect(slashQuery("/")).toBe("");
  });

  it("returns the partial command name while typing it", () => {
    expect(slashQuery("/cod")).toBe("cod");
    expect(slashQuery("/code-review")).toBe("code-review");
  });

  it("closes once arguments begin (first space after the name)", () => {
    expect(slashQuery("/code ")).toBeNull();
    expect(slashQuery("/code review the diff")).toBeNull();
  });

  it("is not a command unless the slash is the very first character", () => {
    expect(slashQuery("hi /code")).toBeNull();
    expect(slashQuery(" /code")).toBeNull();
  });

  it("is closed for ordinary messages and the empty draft", () => {
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  const commands: SlashCommand[] = [
    { name: "code-review", description: "" },
    { name: "clear", description: "" },
    { name: "compact", description: "" },
    { name: "verify", description: "" },
  ];

  it("returns the whole list for an empty query, in source order", () => {
    expect(filterSlashCommands(commands, "").map((c) => c.name)).toEqual([
      "code-review",
      "clear",
      "compact",
      "verify",
    ]);
  });

  it("prefix-matches case-insensitively, preserving order", () => {
    expect(filterSlashCommands(commands, "c").map((c) => c.name)).toEqual([
      "code-review",
      "clear",
      "compact",
    ]);
    expect(filterSlashCommands(commands, "CO").map((c) => c.name)).toEqual([
      "code-review",
      "compact",
    ]);
  });

  it("matches on a prefix only, not a substring", () => {
    // "view" is a substring of "review" but not a prefix, so no match.
    expect(filterSlashCommands(commands, "view")).toEqual([]);
  });

  it("returns nothing when no name starts with the query", () => {
    expect(filterSlashCommands(commands, "zzz")).toEqual([]);
  });
});

describe("applySlashCommand", () => {
  it("produces a `/name ` draft ready for arguments", () => {
    expect(applySlashCommand("code-review")).toBe("/code-review ");
  });

  it("yields a draft that closes the menu (whitespace starts the args)", () => {
    expect(slashQuery(applySlashCommand("verify"))).toBeNull();
  });
});

describe("resolveSlashCommands", () => {
  it("falls back to the defaults when the agent has advertised nothing", () => {
    expect(resolveSlashCommands(undefined)).toBe(DEFAULT_SLASH_COMMANDS);
    expect(resolveSlashCommands([])).toBe(DEFAULT_SLASH_COMMANDS);
  });

  it("uses the live list when present", () => {
    const live = [{ name: "deploy", description: "Ship it" }];
    expect(resolveSlashCommands(live)).toEqual(live);
  });

  it("borrows a default description for a live command that has none", () => {
    // The claude CLI reports names only; known commands get their default blurb.
    const resolved = resolveSlashCommands([{ name: "code-review" }]);
    expect(resolved).toEqual([
      {
        name: "code-review",
        description: "Review the current diff for bugs",
      },
    ]);
  });

  it("leaves an unknown live command's description empty", () => {
    expect(resolveSlashCommands([{ name: "mystery" }])).toEqual([
      { name: "mystery", description: "" },
    ]);
  });
});

describe("DEFAULT_SLASH_COMMANDS", () => {
  it("every default command has a name and a description", () => {
    for (const c of DEFAULT_SLASH_COMMANDS) {
      expect(c.name).toBeTruthy();
      expect(c.name.startsWith("/")).toBe(false);
      expect(c.description).toBeTruthy();
    }
  });

  it("has no duplicate command names", () => {
    const names = DEFAULT_SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
