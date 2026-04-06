import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  acquirePooledSession,
  releasePooledSession,
  removePooledSession,
  listPooledSessions,
  MAX_CONCURRENT_SESSIONS,
} from "../src/session-pool";

// Mock the Cloudflare Browser Rendering acquire() call so tests don't require
// a real Cloudflare account or browser session.
vi.mock("@cloudflare/playwright", () => ({
  acquire: vi.fn(),
}));

import { acquire } from "@cloudflare/playwright";
const mockAcquire = vi.mocked(acquire);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clear all session:* keys from KV between tests. */
async function clearSessionKV(): Promise<void> {
  const kv = env.BROWSER_SESSIONS;
  const list = await kv.list({ prefix: "session:" });
  await Promise.all(list.keys.map((k: KVNamespaceListKey<unknown>) => kv.delete(k.name)));
}

/** Seed an idle session directly into KV (bypasses pool logic). */
async function seedIdleSession(sessionId: string): Promise<void> {
  await env.BROWSER_SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify({
      sessionId,
      status: "idle",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    }),
    { expirationTtl: 120, metadata: { status: "idle" } },
  );
}

/** Seed a busy session directly into KV. */
async function seedBusySession(sessionId: string): Promise<void> {
  await env.BROWSER_SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify({
      sessionId,
      status: "busy",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    }),
    { expirationTtl: 120, metadata: { status: "busy" } },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MAX_CONCURRENT_SESSIONS", () => {
  it("is 2 (Cloudflare paid plan default)", () => {
    expect(MAX_CONCURRENT_SESSIONS).toBe(2);
  });
});

describe("acquirePooledSession", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await clearSessionKV();
  });

  it("acquires a fresh session when the pool is empty", async () => {
    mockAcquire.mockResolvedValue({ sessionId: "sess-001" });

    const result = await acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
    );

    expect(result).toEqual({ sessionId: "sess-001", reused: false });
    expect(mockAcquire).toHaveBeenCalledOnce();
  });

  it("stores the new session in KV as busy", async () => {
    mockAcquire.mockResolvedValue({ sessionId: "sess-002" });

    await acquirePooledSession(env.BROWSER_SESSIONS, env.BROWSER);

    const sessions = await listPooledSessions(env.BROWSER_SESSIONS);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: "sess-002", status: "busy" });
  });

  it("reuses an idle session when the pool is full", async () => {
    await seedBusySession("sess-busy");
    await seedIdleSession("sess-idle");

    const result = await acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
    );

    expect(result).toEqual({ sessionId: "sess-idle", reused: true });
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("marks the reused session as busy in KV", async () => {
    await seedBusySession("sess-busy");
    await seedIdleSession("sess-idle");

    await acquirePooledSession(env.BROWSER_SESSIONS, env.BROWSER);

    const raw = await env.BROWSER_SESSIONS.get("session:sess-idle");
    const session = JSON.parse(raw!);
    expect(session.status).toBe("busy");
  });

  it("returns null when all sessions are busy (pool full)", async () => {
    await seedBusySession("sess-a");
    await seedBusySession("sess-b");

    const result = await acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
    );

    expect(result).toBeNull();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("stores the collectionUrl on newly acquired sessions", async () => {
    mockAcquire.mockResolvedValue({ sessionId: "sess-003" });

    await acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      undefined,
      "https://www.google.com/collections/s/list/ABC",
    );

    const raw = await env.BROWSER_SESSIONS.get("session:sess-003");
    const session = JSON.parse(raw!);
    expect(session.collectionUrl).toBe(
      "https://www.google.com/collections/s/list/ABC",
    );
  });

  describe("specific session reuse (pagination)", () => {
    it("returns the requested session and marks it busy", async () => {
      await seedIdleSession("sess-page");

      const result = await acquirePooledSession(
        env.BROWSER_SESSIONS,
        env.BROWSER,
        "sess-page",
      );

      expect(result).toEqual({ sessionId: "sess-page", reused: true });
      expect(mockAcquire).not.toHaveBeenCalled();
    });

    it("falls through to fresh acquire if the requested session has expired", async () => {
      mockAcquire.mockResolvedValue({ sessionId: "sess-new" });

      // "sess-gone" does not exist in KV.
      const result = await acquirePooledSession(
        env.BROWSER_SESSIONS,
        env.BROWSER,
        "sess-gone",
      );

      expect(result).toEqual({ sessionId: "sess-new", reused: false });
      expect(mockAcquire).toHaveBeenCalledOnce();
    });
  });

  describe("429 retry backoff", () => {
    it("retries once after a 429 and succeeds on the second attempt", async () => {
      vi.useFakeTimers();

      mockAcquire
        .mockRejectedValueOnce(new Error("Unable to create new browser: code: 429: message: Rate limit exceeded"))
        .mockResolvedValueOnce({ sessionId: "sess-retry" });

      // Attach the result handler first so the eventual resolution is caught,
      // then advance all timers to skip the backoff delay.
      const resultPromise = acquirePooledSession(env.BROWSER_SESSIONS, env.BROWSER);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ sessionId: "sess-retry", reused: false });
      expect(mockAcquire).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("throws after exhausting all retries on repeated 429s", async () => {
      vi.useFakeTimers();

      mockAcquire.mockRejectedValue(
        new Error("Unable to create new browser: code: 429: message: Rate limit exceeded"),
      );

      // Attach the rejection handler before advancing timers so the rejection
      // is caught rather than becoming an unhandled promise rejection.
      const assertion = expect(
        acquirePooledSession(env.BROWSER_SESSIONS, env.BROWSER),
      ).rejects.toThrow("429");
      await vi.runAllTimersAsync();
      await assertion;

      // 3 attempts total (initial + 2 retries).
      expect(mockAcquire).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it("does not retry on non-429 errors", async () => {
      mockAcquire.mockRejectedValue(new Error("Network error"));

      await expect(
        acquirePooledSession(env.BROWSER_SESSIONS, env.BROWSER),
      ).rejects.toThrow("Network error");

      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });
  });
});

describe("releasePooledSession", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await clearSessionKV();
  });

  it("transitions a busy session to idle", async () => {
    await seedBusySession("sess-release");

    await releasePooledSession(env.BROWSER_SESSIONS, "sess-release");

    const raw = await env.BROWSER_SESSIONS.get("session:sess-release");
    const session = JSON.parse(raw!);
    expect(session.status).toBe("idle");
  });

  it("updates lastUsedAt when releasing", async () => {
    const before = new Date().toISOString();
    await seedBusySession("sess-time");

    await releasePooledSession(env.BROWSER_SESSIONS, "sess-time");

    const raw = await env.BROWSER_SESSIONS.get("session:sess-time");
    const session = JSON.parse(raw!);
    expect(session.lastUsedAt >= before).toBe(true);
  });

  it("does nothing when the session is not in the pool (already expired)", async () => {
    // Should not throw.
    await expect(
      releasePooledSession(env.BROWSER_SESSIONS, "sess-missing"),
    ).resolves.toBeUndefined();
  });
});

describe("removePooledSession", () => {
  beforeEach(async () => {
    await clearSessionKV();
  });

  it("removes a session from KV", async () => {
    await seedBusySession("sess-dead");

    await removePooledSession(env.BROWSER_SESSIONS, "sess-dead");

    const sessions = await listPooledSessions(env.BROWSER_SESSIONS);
    expect(sessions).toHaveLength(0);
  });

  it("does not throw if the session does not exist", async () => {
    await expect(
      removePooledSession(env.BROWSER_SESSIONS, "sess-nonexistent"),
    ).resolves.toBeUndefined();
  });
});

describe("listPooledSessions", () => {
  beforeEach(async () => {
    await clearSessionKV();
  });

  it("returns an empty array when the pool is empty", async () => {
    const sessions = await listPooledSessions(env.BROWSER_SESSIONS);
    expect(sessions).toEqual([]);
  });

  it("returns all sessions regardless of status", async () => {
    await seedBusySession("sess-x");
    await seedIdleSession("sess-y");

    const sessions = await listPooledSessions(env.BROWSER_SESSIONS);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["sess-x", "sess-y"]);
  });
});
