import { connect } from "@cloudflare/playwright";
import {
  acquirePooledSession,
  releasePooledSession,
  removePooledSession,
  listPooledSessions,
  MAX_CONCURRENT_SESSIONS,
  type SessionPoolOptions,
} from "./session-pool";

/** Parse plan-tier pool options from wrangler env vars. */
export function parsePoolOptions(env: Env): SessionPoolOptions {
  return {
    maxSessions: parseInt(env.BROWSER_MAX_SESSIONS ?? "2", 10),
    keepAliveMs: parseInt(env.BROWSER_KEEP_ALIVE_MS ?? "60000", 10),
  };
}
import { isValidGoogleMapsUrl, normaliseGoogleMapsUrl, validateApiKey } from "./utils";
import {
  captureDebugInfo,
  extractCollectionBlobData,
  extractPlaceCardsFromPage,
  extractPlaceDetails,
  getPaginationInfo,
  type PlaceCard,
} from "./page-extractors";

export { normaliseGoogleMapsUrl };

interface Env {
  BROWSER: any;
  API_KEYS: string;
  BROWSER_SESSIONS: KVNamespace;
  USE_LOCAL_PLAYWRIGHT?: string;
  PLAYWRIGHT_SERVER_URL?: string;
  API_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  /** Maximum concurrent browser sessions (set via wrangler vars). */
  BROWSER_MAX_SESSIONS?: string;
  /** Browser keep-alive duration in milliseconds (set via wrangler vars). */
  BROWSER_KEEP_ALIVE_MS?: string;
}

interface DataImportRequest {
  url: string;
  sessionId?: string;
  pageOffset?: number;
  debug?: boolean;
}

interface PageInfo {
  startIndex: number;
  endIndex: number;
  totalCount: number;
  hasNextPage: boolean;
}

interface CollectionMeta {
  collectionId?: string;
  collectionName?: string;
  totalCount?: number;
}

interface DataImportResponse {
  success: boolean;
  collectionUrl: string;
  sessionId: string;
  places: PlaceCard[];
  pageInfo: PageInfo;
  collectionMeta?: CollectionMeta;
  durationSeconds: number;
  error?: string;
  debug?: {
    htmlContent: string;
    domStructure: string;
  };
}

const ITEMS_PER_PAGE = 200;
const PAGE_LOAD_TIMEOUT = 30000; // 30 seconds for initial page load
const NAVIGATION_TIMEOUT = 30000; // 30 seconds for pagination clicks

/**
 * Handle root page - shows broccoli emoji.
 */
function handleRoot(): Response {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Browserli 🥦</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body {
      height: 100%;
      width: 100%;
    }
    body {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow: hidden;
    }
    .background {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #ddd6fe 0%, #c7d2fe 25%, #a78bfa 50%, #9f7aea 75%, #e9d5ff 100%);
      z-index: -2;
    }
    .pattern-overlay {
      position: fixed;
      inset: 0;
      background-image:
        repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(139, 92, 246, 0.08) 10px, rgba(139, 92, 246, 0.08) 20px),
        repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(168, 85, 247, 0.08) 10px, rgba(168, 85, 247, 0.08) 20px);
      z-index: -1;
    }
    .blur-overlay {
      position: fixed;
      inset: 0;
      backdrop-filter: blur(4px);
      z-index: -1;
    }
    .content {
      position: relative;
      z-index: 1;
      text-align: center;
    }
    .emoji {
      font-size: 200px;
      filter: drop-shadow(0 10px 25px rgba(0, 0, 0, 0.1));
    }
  </style>
</head>
<body>
  <div class="background"></div>
  <div class="pattern-overlay"></div>
  <div class="blur-overlay"></div>
  <div class="content">
    <div class="emoji">🥦</div>
  </div>
</body>
</html>
  `;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    },
  });
}

/**
 * Build a URL with the given pageNumber query parameter for direct page navigation.
 * Google Collections supports ?pageNumber=N (1-indexed) for stable pagination.
 */
export function addPageNumberToUrl(baseUrl: string, pageNum: number): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("pageNumber", String(pageNum + 1));
    return url.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}pageNumber=${pageNum + 1}`;
  }
}

/**
 * Data import handler - extracts place URLs from a Google Maps collection.
 * Handles pagination and returns batches of places.
 */
async function handleDataImport(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    const body = (await request.json()) as DataImportRequest;

    if (!body.url) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing required field: url",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Validate URL to prevent SSRF attacks
    if (!isValidGoogleMapsUrl(body.url)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid URL: must be a valid Google Maps collection or place URL",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const poolOptions = parsePoolOptions(env);

    // Use session reuse if sessionId provided, otherwise start new session.
    let browser: any;
    let sessionId: string;
    let usingPool = false; // Track whether we acquired via the KV pool.

    // Determine if we should use local Playwright.
    const useLocalPlaywright = env.USE_LOCAL_PLAYWRIGHT === "1";
    console.log(
      `[DataImport] useLocalPlaywright=${useLocalPlaywright}, env.USE_LOCAL_PLAYWRIGHT=${env.USE_LOCAL_PLAYWRIGHT}`,
    );

    if (useLocalPlaywright) {
      console.log("[DataImport] Entering local Playwright code path");
      // Local development: use HTTP proxy to local Playwright server
      // This avoids any Node.js module imports in the Worker context
      // Default to HTTP API server on port 3001 (not the WebSocket port 3000)
      const playwrightServerUrl = env.PLAYWRIGHT_SERVER_URL || "http://localhost:3001";

      console.log(`[DataImport] Connecting to local Playwright server: ${playwrightServerUrl}`);

      try {
        // Create a simple HTTP-based browser proxy that uses fetch
        // This works in Worker environments without any Node.js dependencies
        // For local Playwright, generate a sessionId upfront
        sessionId = `local-${Date.now()}`;

        browser = {
          _playwrightServerUrl: playwrightServerUrl,
          _sessionId: sessionId,
          async newPage() {
            // Delegate to the HTTP API on the local server
            return {
              _serverUrl: playwrightServerUrl,
              _sessionId: sessionId,
              async goto(url: string, options: any) {
                const response = await fetch(`${playwrightServerUrl}/api/page/goto`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ url, options, sessionId }),
                });
                if (!response.ok) {
                  throw new Error(`Failed to navigate to ${url}`);
                }
                const data = await response.json();
                return data;
              },
              async evaluate(fn: Function) {
                const response = await fetch(`${playwrightServerUrl}/api/page/evaluate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ script: fn.toString(), sessionId }),
                });
                if (!response.ok) {
                  const error = (await response.json()) as { error: string };
                  throw new Error(`Failed to evaluate script: ${error.error}`);
                }
                const data = (await response.json()) as { result: unknown };
                return data.result;
              },
              async waitForTimeout(ms: number) {
                return new Promise((resolve) => setTimeout(resolve, ms));
              },
              async close() {
                // Close page via HTTP
                await fetch(`${playwrightServerUrl}/api/page/close`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionId }),
                });
              },
              async setDefaultTimeout() {},
              async setDefaultNavigationTimeout() {},
            };
          },
          async close() {
            // Close browser
          },
        };
        console.log(`[DataImport] Connected to local Playwright server (HTTP proxy: ${sessionId})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[DataImport] Failed to connect to local Playwright: ${msg}`);
        throw new Error(
          `Cannot connect to local Playwright server at ${playwrightServerUrl}. ` +
            `Make sure it's running: npm run playwright:server`,
        );
      }
    } else {
      // Production: use Cloudflare Browser Rendering API with session pool.
      const poolResult = await acquirePooledSession(
        env.BROWSER_SESSIONS,
        env.BROWSER,
        body.sessionId,
        body.url,
        poolOptions,
      );

      if (!poolResult) {
        // All browser sessions are currently in use.
        return new Response(
          JSON.stringify({
            success: false,
            error: "All browser sessions are currently busy. Please retry shortly.",
            poolFull: true,
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "30",
            },
          },
        );
      }

      sessionId = poolResult.sessionId;
      usingPool = true;

      try {
        browser = await connect(env.BROWSER, sessionId);
        console.log(
          `[DataImport] Connected to session ${sessionId} (reused: ${poolResult.reused})`,
        );
      } catch (connectError) {
        const msg = connectError instanceof Error ? connectError.message : String(connectError);
        console.error(`[DataImport] Failed to connect to session ${sessionId}: ${msg}`);

        // Session is dead in CF but still tracked in KV — clean it up.
        await removePooledSession(env.BROWSER_SESSIONS, sessionId);

        // Retry once with a fresh session.
        console.log(`[DataImport] Retrying with a fresh session`);
        const retryResult = await acquirePooledSession(
          env.BROWSER_SESSIONS,
          env.BROWSER,
          undefined,
          body.url,
          poolOptions,
        );

        if (!retryResult) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "All browser sessions are currently busy. Please retry shortly.",
              poolFull: true,
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "30",
              },
            },
          );
        }

        sessionId = retryResult.sessionId;
        try {
          browser = await connect(env.BROWSER, sessionId);
        } catch (retryConnectError) {
          const retryMsg =
            retryConnectError instanceof Error
              ? retryConnectError.message
              : String(retryConnectError);
          console.error(
            `[DataImport] Failed to connect to retry session ${sessionId}: ${retryMsg}`,
          );
          await removePooledSession(env.BROWSER_SESSIONS, sessionId);
          return new Response(
            JSON.stringify({
              success: false,
              error: "Browser session unavailable. Please retry shortly.",
            }),
            { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "10" } },
          );
        }
        console.log(`[DataImport] Connected to retry session ${sessionId}`);
      }
    }

    const page = await browser.newPage();
    console.log(`[DataImport] Page created. Session will remain active for ~10 minutes.`);

    // Set default timeout for all page operations (goto, click, evaluate, etc)
    page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

    const pageOffset = body.pageOffset || 0;
    let pageNum = Math.floor(pageOffset / ITEMS_PER_PAGE);
    let totalCount = 0;
    let allPlaces: PlaceCard[] = [];

    try {
      // Navigate directly to the correct page using the pageNumber query param.
      // Google Collections supports ?pageNumber=N (1-indexed) for stable pagination —
      // this is simpler and more reliable than click-based navigation, and also
      // triggers a fresh AF_initDataCallback blob for each page's places.
      const targetUrl = pageNum > 0 ? addPageNumberToUrl(body.url, pageNum) : body.url;
      console.log(`[DataImport] Loading collection page ${pageNum + 1}: ${targetUrl}`);
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT,
      });

      // Extract per-place data and collection metadata from the embedded blob.
      const blobData = await extractCollectionBlobData(page);

      // Extract place cards from the current page DOM.
      console.log(`[DataImport] Extracting places from page ${pageNum + 1}...`);
      const places = await extractPlaceCardsFromPage(page);

      // Merge blob data (savedAt, kgId, photoUrl) into place cards by matching normalised URLs.
      if (blobData.places.size > 0) {
        let matched = 0;
        for (const place of places) {
          const normalised = normaliseGoogleMapsUrl(place.url);
          const data = blobData.places.get(normalised);
          if (data) {
            if (data.savedAt) place.savedAt = data.savedAt;
            if (data.kgId) place.kgId = data.kgId;
            if (data.photoUrl) place.photoUrl = data.photoUrl;
            if (data.lat != null) place.lat = data.lat;
            if (data.lng != null) place.lng = data.lng;
            matched++;
          }
        }
        console.log(`[DataImport] Matched ${matched}/${places.length} places with blob data`);
      }

      if (places.length === 0) {
        console.log("[DataImport] No places found on current page");
      } else {
        console.log(`[DataImport] Found ${places.length} places on page ${pageNum + 1}`);
        allPlaces.push(...places);
      }

      // Get pagination info — use blob totalCount as primary source (more reliable than DOM).
      const { total: domTotal, hasNext } = await getPaginationInfo(page);
      totalCount = blobData.totalCount ?? domTotal;

      console.log(
        `[DataImport] Pagination info: total=${totalCount}, hasNext=${hasNext}, itemsExtracted=${places.length}`,
      );

      // Capture debug info if requested
      let debugInfo: { htmlContent: string; domStructure: string } | undefined;
      if (body.debug) {
        console.log("[DataImport] Capturing debug information...");
        debugInfo = await captureDebugInfo(page);
      }

      await page.close();
      // Don't close browser — just disconnect so session can be reused.

      // Release session back to pool so other requests can use it.
      if (usingPool) {
        await releasePooledSession(env.BROWSER_SESSIONS, sessionId, poolOptions.keepAliveMs);
      }

      const duration = (Date.now() - startTime) / 1000;
      const startIndex = pageNum * ITEMS_PER_PAGE + 1;
      const endIndex = startIndex + allPlaces.length - 1;

      const response: DataImportResponse = {
        success: true,
        collectionUrl: body.url,
        sessionId, // Send back session ID for reuse
        places: allPlaces,
        pageInfo: {
          startIndex,
          endIndex,
          totalCount,
          hasNextPage: hasNext && endIndex < totalCount,
        },
        ...(blobData.collectionId || blobData.collectionName || blobData.totalCount != null
          ? {
              collectionMeta: {
                collectionId: blobData.collectionId,
                collectionName: blobData.collectionName,
                totalCount: blobData.totalCount,
              },
            }
          : {}),
        durationSeconds: duration,
        ...(debugInfo && { debug: debugInfo }),
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[DataImport] Error during extraction: ${errorMessage}`);

      await page.close();
      // Don't close browser — session should remain available for retry.

      // Release session back to pool even on error.
      if (usingPool) {
        await releasePooledSession(env.BROWSER_SESSIONS, sessionId, poolOptions.keepAliveMs);
      }

      const duration = (Date.now() - startTime) / 1000;

      return new Response(
        JSON.stringify({
          success: false,
          collectionUrl: body.url,
          sessionId,
          places: allPlaces,
          pageInfo: {
            startIndex: pageNum * ITEMS_PER_PAGE + 1,
            endIndex: pageNum * ITEMS_PER_PAGE + allPlaces.length,
            totalCount,
            hasNextPage: false,
          },
          durationSeconds: duration,
          error: errorMessage,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[Worker] Data import error:", errorMessage);

    const isRateLimit =
      errorMessage.includes("429") ||
      errorMessage.includes("Rate limit") ||
      errorMessage.includes("rate limited");
    const statusCode = isRateLimit ? 429 : 500;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isRateLimit) {
      headers["Retry-After"] = "120"; // Suggest 2 minute retry
      console.error(
        "[Worker] CLOUDFLARE BROWSER RENDERING RATE LIMITED - Check browserli logs for details",
      );
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: isRateLimit
          ? "Rate limit exceeded. Please retry after 2 minutes."
          : "Failed to process data import request",
        isRateLimit,
      }),
      { status: statusCode, headers },
    );
  }
}

/**
 * Security headers to add to all responses.
 */
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

/**
 * Main request handler.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const poolOptions = parsePoolOptions(env);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...securityHeaders,
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Root page (public)
    if (url.pathname === "/" && request.method === "GET") {
      return handleRoot();
    }

    // Rate limiting for authenticated endpoints (production only)
    if (url.pathname !== "/") {
      try {
        if (env.API_RATE_LIMITER) {
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const { success } = await env.API_RATE_LIMITER.limit({ key: ip });

          if (!success) {
            console.warn(`[RateLimit] Rate limit exceeded for IP: ${ip}`);
            return new Response(
              JSON.stringify({
                success: false,
                error: "Rate limit exceeded",
              }),
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": "60",
                  ...corsHeaders,
                },
              },
            );
          }
        }
      } catch (rateLimitError) {
        // Rate limiting not available in local dev - skip silently
        console.debug(`[RateLimit] Skipped (not available in dev): ${rateLimitError}`);
      }
    }

    // Data import endpoint (requires API key)
    if (!validateApiKey(request, env)) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const authHeader = request.headers.get("Authorization") || "none";
      console.error(
        `[Auth] Failed authentication attempt - IP: ${ip}, Path: ${
          url.pathname
        }, Method: ${request.method}, Auth Header: ${authHeader ? "present" : "missing"}`,
      );

      if (url.pathname !== "/" && request.method === "GET") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/" },
        });
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: "Unauthorized",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        },
      );
    }

    if (url.pathname === "/data-import" && request.method === "POST") {
      const response = await handleDataImport(request, env);
      response.headers.set(
        "Access-Control-Allow-Origin",
        corsHeaders["Access-Control-Allow-Origin"],
      );
      return response;
    }

    // Place details endpoint — proxies to local Playwright server.
    if (url.pathname === "/api/place-details" && request.method === "POST") {
      const useLocalPlaywright = env.USE_LOCAL_PLAYWRIGHT === "1";

      if (useLocalPlaywright) {
        const playwrightServerUrl = env.PLAYWRIGHT_SERVER_URL || "http://localhost:3001";
        const body = (await request.json()) as { url?: string; sessionId?: string };

        // Acquire a session from the pool for local Playwright too
        const poolResult = await acquirePooledSession(
          env.BROWSER_SESSIONS,
          env.BROWSER,
          body.sessionId,
          body.url,
          poolOptions,
        );

        if (!poolResult) {
          return new Response(
            JSON.stringify({
              error: "All browser sessions are currently busy. Please retry shortly.",
              poolFull: true,
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "10",
                ...corsHeaders,
              },
            },
          );
        }

        try {
          const response = await fetch(`${playwrightServerUrl}/api/place-details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...body,
              sessionId: poolResult.sessionId,
            }),
          });

          const data = await response.json();

          // Release session back to pool
          await releasePooledSession(
            env.BROWSER_SESSIONS,
            poolResult.sessionId,
            poolOptions.keepAliveMs,
          );

          return new Response(JSON.stringify(data), {
            status: response.status,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[PlaceDetails] Playwright proxy error: ${msg}`);

          // Release session back to pool on error too
          await releasePooledSession(
            env.BROWSER_SESSIONS,
            poolResult.sessionId,
            poolOptions.keepAliveMs,
          );

          return new Response(JSON.stringify({ error: "Failed to extract place details" }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      } else {
        // Production: use Cloudflare Browser Rendering with session pool.
        try {
          const body = (await request.json()) as { url?: string };
          const placeUrl = body.url;

          if (!placeUrl) {
            return new Response(JSON.stringify({ error: "Missing url parameter" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          if (!isValidGoogleMapsUrl(placeUrl)) {
            return new Response(JSON.stringify({ error: "Invalid URL" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          // Acquire a session from the pool.
          let poolSessionId: string;
          let browser: any;

          const poolResult = await acquirePooledSession(
            env.BROWSER_SESSIONS,
            env.BROWSER,
            undefined,
            undefined,
            poolOptions,
          );

          if (!poolResult) {
            return new Response(
              JSON.stringify({
                error: "All browser sessions are currently busy. Please retry shortly.",
                poolFull: true,
              }),
              {
                status: 503,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": "10",
                  ...corsHeaders,
                },
              },
            );
          }

          poolSessionId = poolResult.sessionId;

          try {
            browser = await connect(env.BROWSER, poolSessionId);
            console.log(
              `[PlaceDetails] Connected to session ${poolSessionId} (reused: ${poolResult.reused})`,
            );
          } catch (connectError) {
            const msg = connectError instanceof Error ? connectError.message : String(connectError);

            // Reused sessions can hit a brief reconnect window just after the
            // previous Worker called browser.close(). Wait 300 ms and try once
            // more on the same session before declaring it dead.
            if (poolResult.reused) {
              await new Promise((r) => setTimeout(r, 300));
              try {
                browser = await connect(env.BROWSER, poolSessionId);
                console.log(
                  `[PlaceDetails] Connected to session ${poolSessionId} after brief reconnect delay`,
                );
              } catch {
                // Fall through to dead-session removal below.
              }
            }

            if (!browser) {
              // No reconnect succeeded — session is dead. Clean up and try again.
              console.error(`[PlaceDetails] Failed to connect to session ${poolSessionId}: ${msg}`);
              await removePooledSession(env.BROWSER_SESSIONS, poolSessionId);

              const retryResult = await acquirePooledSession(
                env.BROWSER_SESSIONS,
                env.BROWSER,
                undefined,
                undefined,
                poolOptions,
              );

              if (!retryResult) {
                return new Response(
                  JSON.stringify({
                    error: "All browser sessions are currently busy. Please retry shortly.",
                    poolFull: true,
                  }),
                  {
                    status: 503,
                    headers: {
                      "Content-Type": "application/json",
                      "Retry-After": "10",
                      ...corsHeaders,
                    },
                  },
                );
              }

              poolSessionId = retryResult.sessionId;
              try {
                browser = await connect(env.BROWSER, poolSessionId);
              } catch (retryConnectError) {
                const retryMsg =
                  retryConnectError instanceof Error
                    ? retryConnectError.message
                    : String(retryConnectError);
                console.error(
                  `[PlaceDetails] Failed to connect to retry session ${poolSessionId}: ${retryMsg}`,
                );
                await removePooledSession(env.BROWSER_SESSIONS, poolSessionId);
                return new Response(
                  JSON.stringify({
                    error: "Browser session unavailable. Please retry shortly.",
                    poolFull: true,
                  }),
                  {
                    status: 503,
                    headers: {
                      "Content-Type": "application/json",
                      "Retry-After": "10",
                      ...corsHeaders,
                    },
                  },
                );
              }
              console.log(`[PlaceDetails] Connected to retry session ${poolSessionId}`);
            }
          }

          // Extract coordinates from the URL's data parameter BEFORE page navigation.
          // The !8m2!3d{lat}!4d{lng} fragment is set server-side by Google and encodes
          // the actual place pin location. It is completely independent of the browser
          // viewport or the Cloudflare data-centre geo-detected location, which causes
          // the /@lat,lng/zoom/ viewport portion of the URL to be wrong (Sydney) when
          // running in Cloudflare Browser Rendering.
          const urlDataParamMatch = placeUrl!.match(/!8m2!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
          const urlDataLat = urlDataParamMatch ? parseFloat(urlDataParamMatch[1]) : null;
          const urlDataLng = urlDataParamMatch ? parseFloat(urlDataParamMatch[2]) : null;
          if (urlDataLat !== null) {
            console.log(`[PlaceDetails] Coords from URL data param: ${urlDataLat}, ${urlDataLng}`);
          }

          const page = await browser.newPage();

          try {
            // Strip /@lat,lng,zoom/ from the URL to prevent the browser inheriting
            // a stale viewport from a previous session visit. Handles both z (zoom level)
            // and m (metres above ground) suffix formats.
            const cleanUrl = placeUrl!.replace(/\/@-?\d+\.?\d*,-?\d+\.?\d*,\d+\.?\d*[mz]\//, "/");
            console.log(`[PlaceDetails] Navigating to: ${cleanUrl}`);
            await page.goto(cleanUrl, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });

            // Wait for the place panel heading to appear.
            await page.waitForSelector("h1", { timeout: 10000 });

            // Resolve pin coordinates — prefer the URL data parameter over any
            // DOM-extracted source, as it is set server-side by Google and is
            // independent of the Cloudflare data-centre geo-detected location
            // (which contaminates the /@lat,lng/ viewport portion of the URL).
            //
            // Collection place URLs are short CID-only URLs (no !8m2!3d yet):
            //   /maps/place/Name/data=!4m2!3m1!1s0x{cid}
            // Google Maps resolves the CID and rewrites the URL to the full form:
            //   /maps/place/Name/@{lat},{lng},{zoom}/data=...!8m2!3d{lat}!4d{lng}...
            // We wait for that rewrite to capture the authoritative pin coordinates.
            let coordLat: number | null = urlDataLat;
            let coordLng: number | null = urlDataLng;

            if (coordLat === null) {
              try {
                // Wait up to 15 s for Google Maps to resolve the CID and populate
                // the data parameter with the place pin coordinates.
                await page.waitForURL(/!8m2!3d/, { timeout: 15000 });
                const resolvedUrl = page.url();
                const m = resolvedUrl.match(/!8m2!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
                if (m) {
                  coordLat = parseFloat(m[1]);
                  coordLng = parseFloat(m[2]);
                  console.log(
                    `[PlaceDetails] Coords from resolved URL data param: ${coordLat}, ${coordLng}`,
                  );
                }
              } catch {
                console.log(
                  "[PlaceDetails] URL did not update with data param coords, falling back to JSON-LD",
                );
              }
            } else {
              console.log(
                `[PlaceDetails] Coords from original URL data param: ${coordLat}, ${coordLng}`,
              );
            }

            // Brief settle delay to ensure secondary elements (address, status)
            // have rendered after the main content loads.
            await page.waitForTimeout(500);

            const details = await extractPlaceDetails(page, coordLat, coordLng);

            await page.close();
            // Explicitly disconnect from the browser before returning.
            // For remotely connected browsers (via connect()), browser.close()
            // disconnects the Worker from the browser server WITHOUT killing the
            // browser process — the CF session stays alive for keep_alive ms.
            // This is a clean handshake that avoids the ungraceful WebSocket
            // teardown caused by the Workers runtime cancelling waitUntil() tasks
            // after the response is sent, which was producing dead-session errors.
            try {
              await browser.close();
            } catch {}
            await releasePooledSession(
              env.BROWSER_SESSIONS,
              poolSessionId,
              poolOptions.keepAliveMs,
            );

            console.log(
              `[PlaceDetails] Extracted: ${details.name} | coords={${details.lat}, ${details.lng}}`,
            );

            return new Response(JSON.stringify({ result: details, sessionId: poolSessionId }), {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[PlaceDetails] Error: ${msg}`);

            await page.close();
            try {
              await browser.close();
            } catch {}
            await releasePooledSession(
              env.BROWSER_SESSIONS,
              poolSessionId,
              poolOptions.keepAliveMs,
            );

            return new Response(JSON.stringify({ error: "Failed to extract place details" }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }
        } catch (outerError) {
          const msg = outerError instanceof Error ? outerError.message : String(outerError);
          console.error(`[PlaceDetails] Unhandled error: ${msg}`);
          const isRateLimit = msg.includes("429") || msg.includes("Rate limit");
          return new Response(
            JSON.stringify({
              error: isRateLimit
                ? "Rate limit exceeded — browser sessions are saturated. Please retry shortly."
                : "An unexpected error occurred. Please retry shortly.",
              poolFull: isRateLimit,
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": isRateLimit ? "30" : "10",
                ...corsHeaders,
              },
            },
          );
        }
      }
    }

    // Session pool debug endpoint (local development only).
    if (url.pathname === "/sessions" && request.method === "GET") {
      // Only allow access during local development
      if (env.USE_LOCAL_PLAYWRIGHT !== "1") {
        console.warn(
          `[Debug] /sessions endpoint accessed in production from ${
            request.headers.get("CF-Connecting-IP") || "unknown"
          }`,
        );
        return new Response(
          JSON.stringify({
            error: "Not found",
            available: ["/data-import", "/api/place-details"],
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          },
        );
      }

      const sessions = await listPooledSessions(env.BROWSER_SESSIONS);
      const body = {
        sessions,
        capacity: {
          used: sessions.length,
          max: MAX_CONCURRENT_SESSIONS,
          available: MAX_CONCURRENT_SESSIONS - sessions.length,
        },
      };
      return new Response(JSON.stringify(body, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response(
      JSON.stringify({
        error: "Not found",
        available: ["/data-import", "/api/place-details", "/sessions"],
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  },
};
