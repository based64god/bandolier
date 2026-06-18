import { beforeEach, describe, expect, it, vi } from "vitest";

import type { db as Database } from "~/server/db";

// Mock the web-push library so no real network call is made; each test drives
// sendNotification's success/failure to exercise the fan-out + pruning logic.
const sendNotification = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const setVapidDetails = vi.fn<(...args: unknown[]) => void>();
vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
  },
}));

// Configurable env so we can flip the VAPID keypair on/off per test.
const envState: Record<string, string | undefined> = {};
vi.mock("~/env", () => ({
  env: new Proxy({}, { get: (_t, key: string) => envState[key] }),
}));

// A tiny db stub recording deletes; select() returns the queued subscriptions.
let subs: Array<{ endpoint: string; p256dh: string; auth: string }>;
const deleted: string[] = [];
const dbStub = {
  select: () => ({
    from: () => ({
      where: () => Promise.resolve(subs),
    }),
  }),
  delete: () => ({
    where: (cond: unknown) => {
      // The endpoint is encoded into the recorded condition by our eq() stub.
      deleted.push(String(cond));
      return Promise.resolve();
    },
  }),
} as unknown as typeof Database;

// drizzle's and()/eq() are pure builders here; stub them to surface the endpoint
// being deleted so the test can assert which subscription was pruned.
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => parts.join("&"),
  eq: (_col: unknown, val: unknown) => String(val),
}));

vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/db/schema", () => ({ pushSubscription: {} }));

import { sendPushToUser, webPushEnabled } from "~/server/agents/web-push";

beforeEach(() => {
  sendNotification.mockReset().mockResolvedValue(undefined);
  setVapidDetails.mockReset();
  deleted.length = 0;
  subs = [];
  envState.WEB_PUSH_VAPID_PUBLIC_KEY = "pub";
  envState.WEB_PUSH_VAPID_PRIVATE_KEY = "priv";
  envState.WEB_PUSH_CONTACT = "mailto:test@example.com";
});

describe("webPushEnabled", () => {
  it("is true when both keys are set", () => {
    expect(webPushEnabled()).toBe(true);
  });

  it("is false when a key is missing", () => {
    envState.WEB_PUSH_VAPID_PRIVATE_KEY = undefined;
    expect(webPushEnabled()).toBe(false);
  });
});

describe("sendPushToUser", () => {
  const payload = { title: "Agent finished", body: "my task" };

  it("no-ops (delivers 0) when push is disabled", async () => {
    envState.WEB_PUSH_VAPID_PUBLIC_KEY = undefined;
    subs = [{ endpoint: "https://push/1", p256dh: "k", auth: "a" }];
    const n = await sendPushToUser("user-1", payload, dbStub);
    expect(n).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("delivers to every subscription a user has", async () => {
    subs = [
      { endpoint: "https://push/1", p256dh: "k1", auth: "a1" },
      { endpoint: "https://push/2", p256dh: "k2", auth: "a2" },
    ];
    const n = await sendPushToUser("user-1", payload, dbStub);
    expect(n).toBe(2);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    // The JSON payload is the second argument to sendNotification.
    expect(sendNotification.mock.calls[0]![1]).toBe(JSON.stringify(payload));
  });

  it("prunes a subscription the push service reports gone (410)", async () => {
    subs = [{ endpoint: "https://push/gone", p256dh: "k", auth: "a" }];
    sendNotification.mockRejectedValueOnce({ statusCode: 410 });
    const n = await sendPushToUser("user-1", payload, dbStub);
    expect(n).toBe(0);
    expect(deleted.some((d) => d.includes("https://push/gone"))).toBe(true);
  });

  it("keeps a subscription on a transient error", async () => {
    subs = [{ endpoint: "https://push/flaky", p256dh: "k", auth: "a" }];
    sendNotification.mockRejectedValueOnce({ statusCode: 500 });
    const n = await sendPushToUser("user-1", payload, dbStub);
    expect(n).toBe(0);
    expect(deleted).toHaveLength(0);
  });

  it("does nothing when the user has no subscriptions", async () => {
    subs = [];
    const n = await sendPushToUser("user-1", payload, dbStub);
    expect(n).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
