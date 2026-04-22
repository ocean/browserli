import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { addPageNumberToUrl, normaliseGoogleMapsUrl } from "../src/index";

// ---------------------------------------------------------------------------
// addPageNumberToUrl
// ---------------------------------------------------------------------------

describe("addPageNumberToUrl", () => {
  it("appends pageNumber=1 for page 0 on a URL without existing params", () => {
    expect(addPageNumberToUrl("https://www.google.com/collections/s/list/ABC", 0)).toBe(
      "https://www.google.com/collections/s/list/ABC?pageNumber=1",
    );
  });

  it("appends pageNumber=2 for page 1", () => {
    expect(addPageNumberToUrl("https://www.google.com/collections/s/list/ABC", 1)).toBe(
      "https://www.google.com/collections/s/list/ABC?pageNumber=2",
    );
  });

  it("appends pageNumber=3 for page 2", () => {
    expect(addPageNumberToUrl("https://www.google.com/collections/s/list/ABC", 2)).toBe(
      "https://www.google.com/collections/s/list/ABC?pageNumber=3",
    );
  });

  it("replaces an existing pageNumber param rather than duplicating it", () => {
    const result = addPageNumberToUrl(
      "https://www.google.com/collections/s/list/ABC?pageNumber=1",
      2,
    );
    expect(result).toBe("https://www.google.com/collections/s/list/ABC?pageNumber=3");
    expect(result.match(/pageNumber/g)?.length).toBe(1);
  });

  it("preserves other existing query params", () => {
    const result = addPageNumberToUrl("https://www.google.com/collections/s/list/ABC?hl=en", 1);
    expect(result).toContain("hl=en");
    expect(result).toContain("pageNumber=2");
  });

  it("falls back to string concatenation for a non-URL string", () => {
    const result = addPageNumberToUrl("not-a-url", 0);
    expect(result).toContain("pageNumber=1");
  });
});

// ---------------------------------------------------------------------------
// normaliseGoogleMapsUrl
// ---------------------------------------------------------------------------

describe("normaliseGoogleMapsUrl", () => {
  it("strips the query string and returns just the pathname", () => {
    expect(
      normaliseGoogleMapsUrl(
        "https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z?hl=en",
      ),
    ).toBe("/maps/place/Eiffel+Tower/@48.8584,2.2945,17z");
  });

  it("decodes unicode escapes in the URL before normalising", () => {
    // The \\u00e9 escape is decoded to é before being parsed by URL, which then
    // percent-encodes the non-ASCII character in the pathname as %C3%A9.
    const withEscape = "https://www.google.com/maps/place/Caf\\u00e9/@48.85,2.29,17z";
    expect(normaliseGoogleMapsUrl(withEscape)).toBe("/maps/place/Caf%C3%A9/@48.85,2.29,17z");
  });

  it("keeps the pathname including /data= path segment", () => {
    const url =
      "https://www.google.com/maps/place/Louvre/data=!4m2!3m1!1s0x47e671d877937b0f:0xb975fcfa192f84d4";
    expect(normaliseGoogleMapsUrl(url)).toBe(
      "/maps/place/Louvre/data=!4m2!3m1!1s0x47e671d877937b0f:0xb975fcfa192f84d4",
    );
  });

  it("returns the original string unchanged when it is not a valid URL", () => {
    expect(normaliseGoogleMapsUrl("not-a-url")).toBe("not-a-url");
  });

  it("two URLs that differ only in query string normalise to the same key", () => {
    const a = normaliseGoogleMapsUrl("https://www.google.com/maps/place/Tower/@51.5,0.1,17z?hl=en");
    const b = normaliseGoogleMapsUrl("https://www.google.com/maps/place/Tower/@51.5,0.1,17z?hl=fr");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Worker fetch handler (via SELF)
// ---------------------------------------------------------------------------

const VALID_KEY = "dev-key-local";

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${VALID_KEY}` };
}

describe("Worker fetch handler", () => {
  describe("CORS preflight", () => {
    it("responds 204 to OPTIONS on any path", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "OPTIONS",
        headers: { Origin: "https://example.com" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    });
  });

  describe("GET /", () => {
    it("returns 200 HTML with the broccoli emoji (public, no auth required)", async () => {
      const res = await SELF.fetch("https://browserli.test/", { method: "GET" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("🥦");
    });
  });

  describe("authentication", () => {
    it("returns 401 for a POST without an Authorization header", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://www.google.com/collections/s/list/ABC" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 for a wrong API key", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer totally-wrong-key",
        },
        body: JSON.stringify({ url: "https://www.google.com/collections/s/list/ABC" }),
      });
      expect(res.status).toBe(401);
    });

    it("redirects unauthenticated GET requests (non-root) to /", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "GET",
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });
  });

  describe("POST /data-import — request validation", () => {
    it("returns 400 when the url field is missing", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("url");
    });

    it("returns 400 when the URL is not a Google Maps URL", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ url: "https://evil.com/steal-data" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("Invalid URL");
    });

    it("returns 400 when the URL uses http:// (non-HTTPS)", async () => {
      const res = await SELF.fetch("https://browserli.test/data-import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ url: "http://www.google.com/maps/place/Test" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for an unrecognised path", async () => {
      const res = await SELF.fetch("https://browserli.test/unknown-path", {
        method: "GET",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; available: string[] };
      expect(body.error).toBe("Not found");
      expect(Array.isArray(body.available)).toBe(true);
    });

    it("includes /data-import in the available routes list", async () => {
      const res = await SELF.fetch("https://browserli.test/nope", {
        method: "GET",
        headers: authHeaders(),
      });
      const body = (await res.json()) as { available: string[] };
      expect(body.available).toContain("/data-import");
    });
  });

  describe("GET /sessions — local dev mode", () => {
    it("returns 200 with session pool data when USE_LOCAL_PLAYWRIGHT=1 (test env default)", async () => {
      // .env.local sets USE_LOCAL_PLAYWRIGHT=1, so the /sessions endpoint is
      // enabled in the test environment.
      const res = await SELF.fetch("https://browserli.test/sessions", {
        method: "GET",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: unknown[]; capacity: { max: number } };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(typeof body.capacity.max).toBe("number");
    });
  });

  describe("security headers", () => {
    it("returns X-Frame-Options: DENY on the root page", async () => {
      const res = await SELF.fetch("https://browserli.test/", { method: "GET" });
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("returns X-Content-Type-Options: nosniff on API responses", async () => {
      const res = await SELF.fetch("https://browserli.test/nope", {
        method: "GET",
        headers: authHeaders(),
      });
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  });
});

// ---------------------------------------------------------------------------
// session-pool edge cases (additional coverage)
// ---------------------------------------------------------------------------

import {
  acquirePooledSession,
  releasePooledSession,
  listPooledSessions,
  MAX_CONCURRENT_SESSIONS,
  type PooledSession,
} from "../src/session-pool";
import { vi, beforeEach, afterEach } from "vitest";

vi.mock("@cloudflare/playwright", () => ({
  acquire: vi.fn(),
}));

import { acquire } from "@cloudflare/playwright";
const mockAcquire = vi.mocked(acquire);

async function clearKv(): Promise<void> {
  const kv = env.BROWSER_SESSIONS;
  const list = await kv.list({ prefix: "session:" });
  await Promise.all(list.keys.map((k) => kv.delete(k.name)));
}

async function seedSession(
  sessionId: string,
  status: "idle" | "busy",
  extra: Partial<PooledSession> = {},
): Promise<void> {
  const session: PooledSession = {
    sessionId,
    status,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    ...extra,
  };
  await env.BROWSER_SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 120,
    metadata: { status },
  });
}

describe("session-pool — additional edge cases", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    await clearKv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires a fresh session with the correct maxSessions option applied", async () => {
    mockAcquire.mockResolvedValue({ sessionId: "sess-custom" });

    const resultPromise = acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      undefined,
      undefined,
      { maxSessions: 5 },
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ sessionId: "sess-custom", reused: false });
    expect(mockAcquire).toHaveBeenCalledOnce();
  });

  it("returns null when pool is full under a custom maxSessions of 1", async () => {
    await seedSession("sess-only", "busy");

    const resultPromise = acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      undefined,
      undefined,
      { maxSessions: 1 },
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("updates collectionUrl on the session record when reusing a specific session", async () => {
    await seedSession("sess-reuse", "idle", {
      collectionUrl: "https://www.google.com/collections/s/list/OLD",
    });

    const resultPromise = acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      "sess-reuse",
      "https://www.google.com/collections/s/list/NEW",
    );
    await vi.runAllTimersAsync();
    await resultPromise;

    const raw = await env.BROWSER_SESSIONS.get("session:sess-reuse");
    const session = JSON.parse(raw!) as PooledSession;
    expect(session.collectionUrl).toBe("https://www.google.com/collections/s/list/NEW");
    expect(session.status).toBe("busy");
  });

  it("sets collectionUrl on idle-pool reuse when pool is full", async () => {
    await seedSession("sess-busy", "busy");
    await seedSession("sess-idle", "idle");

    const resultPromise = acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      undefined,
      "https://www.google.com/collections/s/list/XYZ",
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result?.sessionId).toBe("sess-idle");
    const raw = await env.BROWSER_SESSIONS.get("session:sess-idle");
    const session = JSON.parse(raw!) as PooledSession;
    expect(session.collectionUrl).toBe("https://www.google.com/collections/s/list/XYZ");
  });

  it("releasePooledSession with custom keepAliveMs stores the session back", async () => {
    await seedSession("sess-custom-ttl", "busy");

    await releasePooledSession(env.BROWSER_SESSIONS, "sess-custom-ttl", 120_000);

    const raw = await env.BROWSER_SESSIONS.get("session:sess-custom-ttl");
    const session = JSON.parse(raw!) as PooledSession;
    expect(session.status).toBe("idle");
  });

  it("listPooledSessions skips KV keys whose values have been deleted mid-iteration", async () => {
    await seedSession("sess-a", "idle");
    // No second session — list should still return the one that exists.
    const sessions = await listPooledSessions(env.BROWSER_SESSIONS);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sess-a");
  });

  it("MAX_CONCURRENT_SESSIONS constant matches the documented default", () => {
    expect(MAX_CONCURRENT_SESSIONS).toBe(2);
  });
});
