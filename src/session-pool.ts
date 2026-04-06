/**
 * Browser Session Pool
 *
 * Manages a pool of Cloudflare Browser Rendering sessions using Workers KV.
 * Cloudflare limits accounts to 2 concurrent browser sessions, so this pool
 * tracks active sessions, reuses idle ones, and signals when the pool is full.
 *
 * KV data model:
 * - Key: "session:<sessionId>"
 * - Value: JSON string of PooledSession
 * - Metadata: { status: "idle" | "busy" } for quick list-based querying
 * - TTL: 600 seconds (matches CF browser session ~10 min lifetime)
 */

import { acquire } from "@cloudflare/playwright";

/** Maximum concurrent browser sessions allowed by Cloudflare. */
export const MAX_CONCURRENT_SESSIONS = 2;

/** TTL for KV entries in seconds. Matches CF browser session lifetime. */
const SESSION_TTL_SECONDS = 600;

/** KV key prefix for session entries. */
const SESSION_PREFIX = "session:";

export interface PooledSession {
  sessionId: string;
  status: "idle" | "busy";
  createdAt: string;
  lastUsedAt: string;
  collectionUrl?: string;
}

export interface AcquireResult {
  sessionId: string;
  /** True if reusing an existing idle session rather than acquiring a fresh one. */
  reused: boolean;
}

interface SessionMetadata {
  status: "idle" | "busy";
}

/**
 * Store a session entry in KV with the appropriate TTL and metadata.
 */
async function putSession(
  kv: KVNamespace,
  session: PooledSession,
): Promise<void> {
  const key = `${SESSION_PREFIX}${session.sessionId}`;
  const metadata: SessionMetadata = { status: session.status };

  await kv.put(key, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
    metadata,
  });
}

/**
 * Acquire a Cloudflare browser session with exponential backoff on 429.
 *
 * Cloudflare rate-limits session creation when multiple requests race.
 * Retrying with jitter breaks the synchronisation between concurrent callers.
 */
async function acquireWithRetry(
  browserBinding: any,
  maxAttempts = 3,
): Promise<{ sessionId: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await acquire(browserBinding);
    } catch (error) {
      const isRateLimit =
        error instanceof Error && error.message.includes("429");
      if (!isRateLimit || attempt === maxAttempts - 1) throw error;

      // Exponential backoff with jitter: 1-3 s, 2-6 s, …
      const base = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * base;
      const delay = Math.round(base + jitter);
      console.warn(
        `[SessionPool] Rate limited acquiring session, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable — the loop always throws or returns.
  throw new Error("acquireWithRetry exhausted retries");
}

/**
 * Acquire a browser session from the pool.
 *
 * Logic:
 * 1. If requestedSessionId provided, look it up and mark busy.
 * 2. Otherwise, list all active sessions.
 * 3. If fewer than MAX exist, acquire a fresh one from Cloudflare.
 * 4. If MAX exist and one is idle, reuse it.
 * 5. If MAX exist and all are busy, return null (pool full).
 *
 * Returns null when the pool is full — caller should return HTTP 503.
 */
export async function acquirePooledSession(
  kv: KVNamespace,
  browserBinding: any,
  requestedSessionId?: string,
  collectionUrl?: string,
): Promise<AcquireResult | null> {
  const now = new Date().toISOString();

  // Path 1: caller wants a specific session (pagination reuse).
  if (requestedSessionId) {
    const key = `${SESSION_PREFIX}${requestedSessionId}`;
    const existing = await kv.get(key);

    if (existing) {
      const session: PooledSession = JSON.parse(existing);
      session.status = "busy";
      session.lastUsedAt = now;
      if (collectionUrl) session.collectionUrl = collectionUrl;
      await putSession(kv, session);

      console.log(
        `[SessionPool] Reusing requested session ${requestedSessionId}`,
      );
      return { sessionId: requestedSessionId, reused: true };
    }

    // Requested session not found (expired). Fall through to acquire a new one.
    console.log(
      `[SessionPool] Requested session ${requestedSessionId} not found in pool, will acquire new`,
    );
  }

  // Path 2: list all active sessions to decide what to do.
  const listResult = await kv.list<SessionMetadata>({
    prefix: SESSION_PREFIX,
  });
  const activeKeys = listResult.keys;

  // If room in the pool, acquire a fresh session.
  if (activeKeys.length < MAX_CONCURRENT_SESSIONS) {
    const cfSession = await acquireWithRetry(browserBinding);
    const sessionId = cfSession.sessionId;

    const session: PooledSession = {
      sessionId,
      status: "busy",
      createdAt: now,
      lastUsedAt: now,
      collectionUrl,
    };
    await putSession(kv, session);

    console.log(`[SessionPool] Acquired new session ${sessionId}`);
    return { sessionId, reused: false };
  }

  // Pool is full. Check if any session is idle.
  const idleKey = activeKeys.find((k) => k.metadata?.status === "idle");

  if (idleKey) {
    const sessionId = idleKey.name.replace(SESSION_PREFIX, "");
    const existing = await kv.get(idleKey.name);

    if (existing) {
      const session: PooledSession = JSON.parse(existing);
      session.status = "busy";
      session.lastUsedAt = now;
      if (collectionUrl) session.collectionUrl = collectionUrl;
      await putSession(kv, session);

      console.log(`[SessionPool] Reusing idle session ${sessionId}`);
      return { sessionId, reused: true };
    }
  }

  // All sessions are busy.
  return null;
}

/**
 * Release a session back to the pool as idle.
 * Called after extraction completes so the session can be reused.
 */
export async function releasePooledSession(
  kv: KVNamespace,
  sessionId: string,
): Promise<void> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  const existing = await kv.get(key);

  if (!existing) {
    console.log(
      `[SessionPool] Cannot release session ${sessionId} — not found in pool (may have expired)`,
    );
    return;
  }

  const session: PooledSession = JSON.parse(existing);
  session.status = "idle";
  session.lastUsedAt = new Date().toISOString();
  await putSession(kv, session);

}

/**
 * Remove a session from the pool entirely.
 * Called when a session is known to be dead (e.g. connect() failed).
 */
export async function removePooledSession(
  kv: KVNamespace,
  sessionId: string,
): Promise<void> {
  const key = `${SESSION_PREFIX}${sessionId}`;
  await kv.delete(key);
  console.log(`[SessionPool] Removed dead session ${sessionId} from pool`);
}

/**
 * List all sessions currently tracked in the pool.
 * Used by the /sessions debug endpoint.
 */
export async function listPooledSessions(
  kv: KVNamespace,
): Promise<PooledSession[]> {
  const listResult = await kv.list<SessionMetadata>({
    prefix: SESSION_PREFIX,
  });

  const sessions: PooledSession[] = [];

  for (const key of listResult.keys) {
    const value = await kv.get(key.name);
    if (value) {
      sessions.push(JSON.parse(value));
    }
  }

  return sessions;
}
