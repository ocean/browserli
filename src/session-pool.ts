/**
 * Browser Session Pool
 *
 * Manages a pool of Cloudflare Browser Rendering sessions using Workers KV.
 * The maximum concurrent sessions and keep-alive duration are configurable
 * to support both free and paid Cloudflare plans.
 *
 * KV data model:
 * - Key: "session:<sessionId>"
 * - Value: JSON string of PooledSession
 * - Metadata: { status: "idle" | "busy" } for quick list-based querying
 * - TTL: derived from keepAliveMs to match the browser's inactivity timeout
 *
 * Note on KV metadata consistency: KV list metadata can be up to 60 seconds
 * stale. To guard against two Workers simultaneously reusing the same idle
 * session, we re-read the full session value after finding an idle key in the
 * list and verify the status is still "idle" before marking it busy.
 */

import { acquire } from "@cloudflare/playwright";

/** Default maximum concurrent browser sessions (Cloudflare free plan limit). */
export const MAX_CONCURRENT_SESSIONS = 2;

/**
 * Minimum KV TTL in seconds (Cloudflare KV enforces a 60-second minimum).
 * Used to clamp derived idle TTLs so KV doesn't reject the put.
 */
const MIN_KV_TTL_SECONDS = 60;

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

export interface SessionPoolOptions {
  /** Maximum concurrent sessions allowed. Defaults to MAX_CONCURRENT_SESSIONS. */
  maxSessions?: number;
  /**
   * Browser keep-alive duration in milliseconds. Passed to acquire() and used
   * to derive KV TTLs so stale pool entries expire in sync with the browser.
   * Defaults to 60_000 ms (Cloudflare free plan default).
   */
  keepAliveMs?: number;
}

interface SessionMetadata {
  status: "idle" | "busy";
}

/**
 * Compute KV TTLs from the browser keep-alive setting.
 *
 * - idleTtl: matches the browser inactivity timeout so stale entries don't
 *   linger after Cloudflare kills the session.
 * - busyTtl: double the keep-alive to cover active sessions that renew their
 *   own inactivity timer through ongoing page interactions.
 */
function computeTtls(keepAliveMs: number): { idleTtl: number; busyTtl: number } {
  const keepAliveSecs = Math.floor(keepAliveMs / 1000);
  const idleTtl = Math.max(MIN_KV_TTL_SECONDS, keepAliveSecs);
  const busyTtl = Math.max(MIN_KV_TTL_SECONDS * 2, keepAliveSecs * 2);
  return { idleTtl, busyTtl };
}

/**
 * Store a session entry in KV with the appropriate TTL and metadata.
 */
async function putSession(
  kv: KVNamespace,
  session: PooledSession,
  keepAliveMs: number,
): Promise<void> {
  const key = `${SESSION_PREFIX}${session.sessionId}`;
  const metadata: SessionMetadata = { status: session.status };
  const { idleTtl, busyTtl } = computeTtls(keepAliveMs);
  const ttl = session.status === "idle" ? idleTtl : busyTtl;

  await kv.put(key, JSON.stringify(session), { expirationTtl: ttl, metadata });
}

/**
 * Acquire a Cloudflare browser session with exponential backoff on 429.
 *
 * Cloudflare rate-limits session creation when multiple requests race.
 * Retrying with jitter breaks the synchronisation between concurrent callers.
 * The keepAliveMs value is forwarded to acquire() so the browser session
 * stays alive for the configured inactivity period.
 */
async function acquireWithRetry(
  browserBinding: any,
  keepAliveMs: number,
  maxAttempts = 3,
): Promise<{ sessionId: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await acquire(browserBinding, { keep_alive: keepAliveMs });
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
 * 3. If fewer than maxSessions exist, acquire a fresh one from Cloudflare.
 * 4. If maxSessions exist and one is idle, reuse it.
 * 5. If maxSessions exist and all are busy, return null (pool full).
 *
 * KV list metadata can be stale by ~60 s, so when reusing an idle session
 * from the list we re-read the full value and verify it is still idle before
 * claiming it, to avoid two Workers racing on the same session.
 *
 * Returns null when the pool is full — caller should return HTTP 503.
 */
export async function acquirePooledSession(
  kv: KVNamespace,
  browserBinding: any,
  requestedSessionId?: string,
  collectionUrl?: string,
  options?: SessionPoolOptions,
): Promise<AcquireResult | null> {
  const maxSessions = options?.maxSessions ?? MAX_CONCURRENT_SESSIONS;
  const keepAliveMs = options?.keepAliveMs ?? 60_000;
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
      await putSession(kv, session, keepAliveMs);

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
  if (activeKeys.length < maxSessions) {
    // Pre-acquire jitter: CF rate-limits new browser sessions to ~30/minute.
    // When many Workers start simultaneously (e.g. bulk import), they all see a
    // stale KV list showing room in the pool and race to call acquire().
    // A random delay of 0–2 s spreads the burst. After waiting, we re-read the
    // pool — a later Worker may find slots already filled and avoid acquiring.
    const jitterMs = Math.floor(Math.random() * 2000);
    await new Promise(r => setTimeout(r, jitterMs));

    const freshList = await kv.list<SessionMetadata>({ prefix: SESSION_PREFIX });
    const freshKeys = freshList.keys;

    // Pool was filled during jitter — try to claim an idle session.
    if (freshKeys.length >= maxSessions) {
      for (const key of freshKeys) {
        if (key.metadata?.status !== "idle") continue;
        const sessionId = key.name.replace(SESSION_PREFIX, "");
        const existing = await kv.get(key.name);
        if (!existing) continue;
        const session: PooledSession = JSON.parse(existing);
        if (session.status !== "idle") continue;
        session.status = "busy";
        session.lastUsedAt = now;
        if (collectionUrl) session.collectionUrl = collectionUrl;
        await putSession(kv, session, keepAliveMs);
        console.log(`[SessionPool] Reusing idle session ${sessionId} (post-jitter)`);
        return { sessionId, reused: true };
      }
      // Pool is full and all sessions are busy.
      return null;
    }

    // Pool still has room — acquire. Convert 429-exhausted errors to null
    // (pool-full signal) so callers get a 503 and retry with backoff, rather
    // than the Worker crashing with an unhandled exception.
    let cfSession: { sessionId: string };
    try {
      cfSession = await acquireWithRetry(browserBinding, keepAliveMs);
    } catch (acquireError) {
      const msg = acquireError instanceof Error ? acquireError.message : String(acquireError);
      if (msg.includes("429")) {
        console.warn("[SessionPool] Rate limit exhausted acquiring session, treating pool as temporarily full");
        return null;
      }
      throw acquireError;
    }
    const sessionId = cfSession.sessionId;

    const session: PooledSession = {
      sessionId,
      status: "busy",
      createdAt: now,
      lastUsedAt: now,
      collectionUrl,
    };
    await putSession(kv, session, keepAliveMs);

    console.log(`[SessionPool] Acquired new session ${sessionId}`);
    return { sessionId, reused: false };
  }

  // Pool is full. Scan idle sessions from the list, re-reading each full value
  // to confirm it is still idle (guards against stale KV list metadata).
  for (const key of activeKeys) {
    if (key.metadata?.status !== "idle") continue;

    const sessionId = key.name.replace(SESSION_PREFIX, "");
    const existing = await kv.get(key.name);
    if (!existing) continue;

    const session: PooledSession = JSON.parse(existing);

    // Stale metadata race: another Worker already claimed this session.
    if (session.status !== "idle") continue;

    session.status = "busy";
    session.lastUsedAt = now;
    if (collectionUrl) session.collectionUrl = collectionUrl;
    await putSession(kv, session, keepAliveMs);

    console.log(`[SessionPool] Reusing idle session ${sessionId}`);
    return { sessionId, reused: true };
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
  keepAliveMs = 60_000,
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
  await putSession(kv, session, keepAliveMs);
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
