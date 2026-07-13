import { describe, expect, it } from "vitest";

import type { ModelOption } from "~/server/agents/models";
import {
  modelKey,
  resolveEffectiveModel,
} from "~/app/dashboard/_components/resolve-effective-model";

const opus: ModelOption = {
  id: "claude-opus-4-8",
  label: "Claude Opus 4.8",
  provider: "anthropic",
  auth: "api_key",
};
const sonnet: ModelOption = {
  id: "claude-sonnet-5",
  label: "Claude Sonnet 5",
  provider: "anthropic",
  auth: "api_key",
};
const opusSub: ModelOption = {
  id: "claude-opus-4-8",
  label: "Claude Opus 4.8",
  provider: "anthropic",
  auth: "subscription",
};
const gpt: ModelOption = {
  id: "gpt-5.5",
  label: "GPT-5.5",
  provider: "openai",
};

describe("modelKey", () => {
  it("suffixes the auth kind so a model offered twice stays distinct", () => {
    expect(modelKey(opus)).toBe("claude-opus-4-8::api_key");
    expect(modelKey(opusSub)).toBe("claude-opus-4-8::subscription");
  });

  it("uses the bare id when there's no auth kind", () => {
    expect(modelKey(gpt)).toBe("gpt-5.5");
  });
});

describe("resolveEffectiveModel", () => {
  it("returns empty selection when no models are available", () => {
    const r = resolveEffectiveModel([], "", "");
    expect(r.effectiveKey).toBe("");
    expect(r.selected).toBeNull();
    expect(r.isPreferred).toBe(false);
    expect(r.submitId).toBe("");
  });

  it("honours an explicit choice over the default", () => {
    const r = resolveEffectiveModel(
      [opus, sonnet],
      modelKey(opus),
      modelKey(sonnet),
    );
    expect(r.effectiveKey).toBe(modelKey(opus));
    expect(r.selected).toBe(opus);
    expect(r.submitId).toBe("claude-opus-4-8");
  });

  it("defaults to the preferred model when there's no explicit choice", () => {
    const r = resolveEffectiveModel([opus, sonnet], "", modelKey(opus));
    expect(r.selected).toBe(opus);
    expect(r.isPreferred).toBe(true);
  });

  it("falls back to a Sonnet when no preference is set", () => {
    const r = resolveEffectiveModel([opus, sonnet, gpt], "", "");
    expect(r.selected).toBe(sonnet);
    expect(r.isPreferred).toBe(false);
  });

  it("falls back to the first model when no Sonnet exists", () => {
    const r = resolveEffectiveModel([opus, gpt], "", "");
    expect(r.selected).toBe(opus);
  });

  it("resolves a legacy bare-id preference and marks it preferred", () => {
    const r = resolveEffectiveModel([opusSub], "", "claude-opus-4-8");
    expect(r.selected).toBe(opusSub);
    expect(r.effectiveKey).toBe("claude-opus-4-8::subscription");
    expect(r.isPreferred).toBe(true);
  });

  it("disambiguates two auth kinds of the same id by key", () => {
    const r = resolveEffectiveModel([opus, opusSub], modelKey(opusSub), "");
    expect(r.selected).toBe(opusSub);
    expect(r.selected?.auth).toBe("subscription");
  });

  it("strips the credential kind for submitId when the key names a missing model", () => {
    const r = resolveEffectiveModel([], "claude-opus-4-8::api_key", "");
    expect(r.selected).toBeNull();
    expect(r.submitId).toBe("claude-opus-4-8");
  });
});
