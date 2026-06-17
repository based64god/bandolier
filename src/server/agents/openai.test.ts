import { describe, expect, it } from "vitest";

import { isChatModel } from "~/server/agents/openai";

describe("isChatModel", () => {
  it("keeps GPT chat families", () => {
    for (const id of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-5",
      "gpt-5-mini",
      "chatgpt-4o-latest",
    ]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it("keeps the o-series reasoning models", () => {
    for (const id of [
      "o1",
      "o1-preview",
      "o1-mini",
      "o3",
      "o3-mini",
      "o4-mini",
    ]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it("drops non-chat endpoints", () => {
    for (const id of [
      "text-embedding-3-large",
      "text-embedding-ada-002",
      "whisper-1",
      "tts-1",
      "tts-1-hd",
      "gpt-4o-audio-preview",
      "gpt-4o-realtime-preview",
      "gpt-4o-transcribe",
      "gpt-image-1",
      "dall-e-3",
      "omni-moderation-latest",
      "gpt-4o-search-preview",
      "gpt-3.5-turbo-instruct",
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });

  it("drops models outside the chat families entirely", () => {
    for (const id of ["text-davinci-003", "babbage-002", "claude-sonnet-4-6"]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });

  it("is case-insensitive on the family prefix", () => {
    expect(isChatModel("GPT-4o")).toBe(true);
    expect(isChatModel("O1-Preview")).toBe(true);
  });
});
