import { connect } from "@cloudflare/playwright";
import {
  acquirePooledSession,
  releasePooledSession,
  removePooledSession,
  listPooledSessions,
  MAX_CONCURRENT_SESSIONS,
} from "./session-pool";

interface Env {
  BROWSER: any;
  API_KEYS: string;
  BROWSER_SESSIONS: KVNamespace;
  USE_LOCAL_PLAYWRIGHT?: string;
  PLAYWRIGHT_SERVER_URL?: string;
}

interface DataImportRequest {
  url: string;
  sessionId?: string;
  pageOffset?: number;
  debug?: boolean;
}

interface PlaceCard {
  name: string;
  url: string;
  rating?: number;
  reviewCount?: number;
  note?: string;
  savedAt?: number;   // Unix timestamp (seconds) when place was saved to the collection.
  kgId?: string;      // Google Knowledge Graph ID, e.g. "/g/11ltqq0zv9".
  photoUrl?: string;  // First photo thumbnail URL from the collection blob.
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
const POLL_INTERVAL = 500; // ms between polls during pagination

/**
 * Validate that a URL is a Google Maps collection/place URL to prevent SSRF attacks.
 */
function isValidGoogleMapsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow https
    if (parsed.protocol !== "https:") {
      return false;
    }

    // Allow google.com domain with /maps/, /collections/, or /placelists/ paths
    if (parsed.hostname.includes("google.com")) {
      const path = parsed.pathname;
      if (
        path.includes("/maps/") ||
        path.includes("/collections/") ||
        path.includes("/placelists/")
      ) {
        return true;
      }
    }

    // Also allow maps.app.goo.gl short URLs
    if (parsed.hostname === "maps.app.goo.gl") {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Validate API key from request headers using constant-time comparison.
 */
function validateApiKey(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer") {
    return false;
  }

  const allowedKeys = env.API_KEYS.split(",").map((k) => k.trim());

  // Use constant-time comparison to prevent timing attacks
  for (const key of allowedKeys) {
    if (timingSafeEqual(token, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

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
      "Content-Security-Policy":
        "default-src 'self'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    },
  });
}

/**
 * Capture debug information about the page structure.
 * Returns raw HTML and DOM analysis for troubleshooting selectors.
 */
async function captureDebugInfo(
  page: any,
): Promise<{ htmlContent: string; domStructure: string }> {
  try {
    const [htmlContent, domStructure] = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;

      // Analyse the DOM structure to help debug selectors
      const placeLinks = document.querySelectorAll('a[href*="/maps/place/"]');
      const samplePlaceLinks = Array.from(placeLinks)
        .slice(0, 15)
        .map((a) => ({
          href: (a as HTMLAnchorElement).href.slice(0, 100),
          text: a.textContent?.slice(0, 100),
          classes: (a as HTMLElement).className,
          innerHTML: a.innerHTML.slice(0, 150),
          hasChildren: (a as HTMLElement).children.length,
          parent: {
            tag: (a.parentElement?.tagName).toLowerCase(),
            classes: a.parentElement?.className.slice(0, 100),
          },
        }));

      const analysis = {
        allLinks: document.querySelectorAll("a").length,
        mapsPlaceLinks: placeLinks.length,
        containers: {
          dataItemIdContainers:
            document.querySelectorAll("[data-item-id]").length,
          roleHeadings: document.querySelectorAll('[role="heading"]').length,
          roleNavigations: document.querySelectorAll('[role="navigation"]')
            .length,
          buttons: document.querySelectorAll("button").length,
        },
        samplePlaceLinks,
        htmlSnippet: html.slice(
          Math.max(0, html.indexOf('<div role="main">')),
          Math.max(0, html.indexOf('<div role="main">')) + 2000,
        ),
      };

      return [html, JSON.stringify(analysis, null, 2)];
    });

    return { htmlContent, domStructure };
  } catch (error) {
    console.error("[DataImport] Error capturing debug info:", error);
    return { htmlContent: "", domStructure: "" };
  }
}

interface CollectionPlaceData {
  savedAt?: number;
  kgId?: string;
  photoUrl?: string;
}

interface CollectionBlobResult {
  places: Map<string, CollectionPlaceData>;
  totalCount?: number;
  collectionId?: string;
  collectionName?: string;
}

/**
 * Extract per-place data and collection metadata from the AF_initDataCallback blob.
 *
 * Google Collections pages embed a large data array in a <script class="ds:0"> tag.
 * Per-place fields extracted:
 *   - [5]       → Google Maps URL (used as the matching key)
 *   - [37][5]   → Knowledge Graph ID, e.g. "/g/11ltqq0zv9"
 *   - [43][0][0] → First photo thumbnail URL
 *   - [45][0]   → Unix timestamp (seconds) when place was saved to the collection
 *
 * Collection-level metadata (capturedData[13]):
 *   - [13][0]   → Collection ID
 *   - [13][2]   → Collection name
 *   - [13][3]   → Total place count (accurate across all pages)
 *
 * Returns a Map of normalised URL → CollectionPlaceData, plus collection metadata.
 */
async function extractCollectionBlobData(
  page: any,
): Promise<CollectionBlobResult> {
  try {
    const extracted: {
      entries: Array<{
        url: string;
        savedAt?: number;
        kgId?: string;
        photoUrl?: string;
      }>;
      totalCount?: number;
      collectionId?: string;
      collectionName?: string;
    } = await page.evaluate(() => {
      const script = document.querySelector("script.ds\\:0");
      if (!script) return { entries: [] };

      // Re-execute AF_initDataCallback to capture the parsed data blob.
      let capturedData: any = null;
      const origFn = (window as any).AF_initDataCallback;
      (window as any).AF_initDataCallback = (obj: any) => {
        capturedData = obj.data;
      };

      try {
        new Function(script.textContent || "")();
      } catch (_) {
        return { entries: [] };
      }

      (window as any).AF_initDataCallback = origFn;

      if (!capturedData?.[1] || !Array.isArray(capturedData[1])) {
        return { entries: [] };
      }

      // Collection-level metadata.
      const meta = capturedData[13];
      const totalCount =
        typeof meta?.[3] === "number" ? meta[3] : undefined;
      const collectionId =
        typeof meta?.[0] === "string" ? meta[0] : undefined;
      const collectionName =
        typeof meta?.[2] === "string" ? meta[2] : undefined;

      const entries: Array<{
        url: string;
        savedAt?: number;
        kgId?: string;
        photoUrl?: string;
      }> = [];

      for (const place of capturedData[1]) {
        const url = place?.[5];
        if (typeof url !== "string" || !url) continue;

        const savedAtRaw = place?.[45]?.[0];
        const kgIdRaw = place?.[37]?.[5];
        const photoUrlRaw = place?.[43]?.[0]?.[0];

        entries.push({
          url,
          savedAt:
            typeof savedAtRaw === "number" && savedAtRaw > 0
              ? savedAtRaw
              : undefined,
          kgId:
            typeof kgIdRaw === "string" && kgIdRaw ? kgIdRaw : undefined,
          photoUrl:
            typeof photoUrlRaw === "string" && photoUrlRaw
              ? photoUrlRaw
              : undefined,
        });
      }

      return { entries, totalCount, collectionId, collectionName };
    });

    // Build lookup map keyed by normalised URL pathname for matching against DOM-scraped hrefs.
    const map = new Map<string, CollectionPlaceData>();
    for (const entry of extracted.entries) {
      const normalised = normaliseGoogleMapsUrl(entry.url);
      map.set(normalised, {
        savedAt: entry.savedAt,
        kgId: entry.kgId,
        photoUrl: entry.photoUrl,
      });
    }

    console.log(
      `[DataImport] Extracted ${map.size} place records from AF_initDataCallback blob`,
    );

    return {
      places: map,
      totalCount: extracted.totalCount,
      collectionId: extracted.collectionId,
      collectionName: extracted.collectionName,
    };
  } catch (error) {
    console.error("[DataImport] Error extracting collection blob data:", error);
    return { places: new Map() };
  }
}

/**
 * Build a URL with the given pageNumber query parameter for direct page navigation.
 * Google Collections supports ?pageNumber=N (1-indexed) for stable pagination.
 */
function addPageNumberToUrl(baseUrl: string, pageNum: number): string {
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
 * Normalise a Google Maps URL for matching.
 * Strips query strings and decodes unicode escapes so URLs from the
 * AF_initDataCallback blob can be matched against DOM-scraped hrefs.
 */
function normaliseGoogleMapsUrl(url: string): string {
  try {
    // Decode any unicode escapes (e.g. \u003d → =).
    const decoded = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    const parsed = new URL(decoded);
    // Keep only the pathname and the data= parameter for matching.
    return parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * Extract place data from cards on current page.
 * Returns structured data from visible place cards ONLY on current viewport.
 */
async function extractPlaceCardsFromPage(page: any): Promise<PlaceCard[]> {
  try {
    const places = await page.evaluate(() => {
      const placeCards: PlaceCard[] = [];

      // Google Maps collection places: look for links with class "ir" (text-based cards)
      // Important: we only extract from the current page viewport, not deduplicating across pages
      // This ensures pagination works correctly
      const placeLinks = document.querySelectorAll(
        'a[href*="/maps/place/"][class*="ir"]',
      );

      placeLinks.forEach((link) => {
        try {
          const href = (link as HTMLAnchorElement).href;
          if (!href || !href.includes("/maps/place/")) return;

          const fullText = link.textContent?.trim() || "";
          if (!fullText || fullText.length < 3) return;

          // Parse: "Place Name4.5(88)" or "Place Name4.2(1.51K)" -> name, rating, reviews.
          const match = fullText.match(/^(.+?)(\d+\.?\d*)\((\d+\.?\d*K?)\)$/);
          let name = fullText;
          let rating: number | undefined;
          let reviewCount: number | undefined;

          if (match) {
            name = match[1].trim();
            if (match[2]) rating = parseFloat(match[2]);
            if (match[3]) {
              const countStr = match[3];
              if (countStr.endsWith("K")) {
                reviewCount = Math.round(
                  parseFloat(countStr.slice(0, -1)) * 1000,
                );
              } else {
                reviewCount = parseInt(countStr);
              }
            }
          }

          // Fallback cleanup for any remaining rating/review suffixes.
          name = name.replace(/\d+\.?\d*\s*\(\d+\.?\d*K?\)$/, "").trim();
          if (!name || name.length < 2) return;

          // Extract user note from the card container.
          // Notes live in a span[role="textbox"] within the card's TOmvfe container,
          // with the full (untruncated) text in the aria-label attribute.
          let note: string | undefined;
          const cardContainer = link.closest(".TOmvfe");
          if (cardContainer) {
            const noteEl = cardContainer.querySelector('span[role="textbox"]');
            if (noteEl) {
              note =
                noteEl.getAttribute("aria-label")?.trim() ||
                noteEl.textContent?.trim() ||
                undefined;
            }
          }

          placeCards.push({ name, url: href, rating, reviewCount, note });
        } catch (e) {
          // Silently skip malformed entries
        }
      });

      return placeCards;
    });

    return places;
  } catch (error) {
    console.error("[DataImport] Error extracting place cards:", error);
    return [];
  }
}

/**
 * Get pagination info from current page.
 * Returns total count and whether next page is available.
 */
async function getPaginationInfo(
  page: any,
): Promise<{ total: number; hasNext: boolean }> {
  try {
    return await page.evaluate(() => {
      // Look for pagination text like "1-200 of 237"
      const paginationEls = document.querySelectorAll(
        '[role="navigation"], .Azx0Fe, [aria-label*="pagination"]',
      );

      let total = 0;
      let hasNext = false;

      for (const el of paginationEls) {
        const text = el.textContent || "";
        // Match patterns like "1-200 of 237"
        const match = text.match(/\d+-(\d+)\s+of\s+(\d+)/);
        if (match) {
          const endIndex = parseInt(match[1]);
          total = parseInt(match[2]);
          hasNext = endIndex < total;
          break;
        }
      }

      // Check if next button is enabled
      const nextButton = document.querySelector(
        'button[aria-label*="Next"], [aria-label*="next page"]',
      ) as HTMLButtonElement;
      if (nextButton) {
        hasNext = !nextButton.hasAttribute("disabled");
      }

      return { total, hasNext };
    });
  } catch (error) {
    console.error("[DataImport] Error getting pagination info:", error);
    return { total: 0, hasNext: false };
  }
}

/**
 * Click the next button to navigate to the next page.
 */
async function goToNextPage(page: any): Promise<boolean> {
  try {
    // Use evaluate() for all DOM interaction so it works with both
    // the local HTTP proxy and real Playwright page objects.
    const buttonStatus = await page.evaluate(() => {
      const btn = document.querySelector(
        'button[aria-label*="Next page"], button[aria-label*="next"]',
      ) as HTMLButtonElement | null;
      if (!btn) return "not_found";
      if (btn.disabled) return "disabled";
      return "ready";
    });

    if (buttonStatus === "not_found") {
      console.log("[DataImport] No next button found");
      return false;
    }

    if (buttonStatus === "disabled") {
      console.log("[DataImport] Next button is disabled");
      return false;
    }

    console.log("[DataImport] Clicking next button...");

    // Get initial place count and click in one evaluate call
    const initialCount = await page.evaluate(() => {
      const count = document.querySelectorAll(
        'a[href*="/maps/place/"][class*="ir"]',
      ).length;
      const btn = document.querySelector(
        'button[aria-label*="Next page"], button[aria-label*="next"]',
      ) as HTMLButtonElement | null;
      if (btn) btn.click();
      return count;
    });
    console.log(`[DataImport] Initial card count: ${initialCount}`);

    // Wait for the page to load new content by polling for DOM changes
    let pageChanged = false;
    let attempts = 0;
    const maxAttempts = Math.ceil(NAVIGATION_TIMEOUT / POLL_INTERVAL);

    while (!pageChanged && attempts < maxAttempts) {
      await page.waitForTimeout(POLL_INTERVAL);

      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="/maps/place/"][class*="ir"]')
          .length;
      });

      // Page has changed if the count is different (new content loaded)
      if (currentCount !== initialCount) {
        pageChanged = true;
        console.log(
          `[DataImport] Page changed detected. Old count: ${initialCount}, New count: ${currentCount}`,
        );
      }

      attempts++;
    }

    if (!pageChanged) {
      console.log(
        "[DataImport] Warning: page did not change after clicking next button",
      );
    }

    // Scroll to top to ensure we're at the start of the new page
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });

    return true;
  } catch (error) {
    console.error("[DataImport] Error navigating to next page:", error);
    return false;
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
          error:
            "Invalid URL: must be a valid Google Maps collection or place URL",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

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
      const playwrightServerUrl =
        env.PLAYWRIGHT_SERVER_URL || "http://localhost:3001";

      console.log(
        `[DataImport] Connecting to local Playwright server: ${playwrightServerUrl}`,
      );

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
                const response = await fetch(
                  `${playwrightServerUrl}/api/page/goto`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url, options, sessionId }),
                  },
                );
                if (!response.ok) {
                  throw new Error(`Failed to navigate to ${url}`);
                }
                const data = await response.json();
                return data;
              },
              async evaluate(fn: Function) {
                const response = await fetch(
                  `${playwrightServerUrl}/api/page/evaluate`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ script: fn.toString(), sessionId }),
                  },
                );
                if (!response.ok) {
                  const error = await response.json();
                  throw new Error(`Failed to evaluate script: ${error.error}`);
                }
                const data = await response.json();
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
        console.log(
          `[DataImport] Connected to local Playwright server (HTTP proxy: ${sessionId})`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[DataImport] Failed to connect to local Playwright: ${msg}`,
        );
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
      );

      if (!poolResult) {
        // All browser sessions are currently in use.
        return new Response(
          JSON.stringify({
            success: false,
            error:
              "All browser sessions are currently busy. Please retry shortly.",
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
        const msg =
          connectError instanceof Error
            ? connectError.message
            : String(connectError);
        console.error(
          `[DataImport] Failed to connect to session ${sessionId}: ${msg}`,
        );

        // Session is dead in CF but still tracked in KV — clean it up.
        await removePooledSession(env.BROWSER_SESSIONS, sessionId);

        // Retry once with a fresh session.
        console.log(`[DataImport] Retrying with a fresh session`);
        const retryResult = await acquirePooledSession(
          env.BROWSER_SESSIONS,
          env.BROWSER,
          undefined,
          body.url,
        );

        if (!retryResult) {
          return new Response(
            JSON.stringify({
              success: false,
              error:
                "All browser sessions are currently busy. Please retry shortly.",
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
        browser = await connect(env.BROWSER, sessionId);
        console.log(`[DataImport] Connected to retry session ${sessionId}`);
      }
    }

    const page = await browser.newPage();
    console.log(
      `[DataImport] Page created. Session will remain active for ~10 minutes.`,
    );

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
      const targetUrl =
        pageNum > 0 ? addPageNumberToUrl(body.url, pageNum) : body.url;
      console.log(
        `[DataImport] Loading collection page ${pageNum + 1}: ${targetUrl}`,
      );
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
            matched++;
          }
        }
        console.log(
          `[DataImport] Matched ${matched}/${places.length} places with blob data`,
        );
      }

      if (places.length === 0) {
        console.log("[DataImport] No places found on current page");
      } else {
        console.log(
          `[DataImport] Found ${places.length} places on page ${pageNum + 1}`,
        );
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
        await releasePooledSession(env.BROWSER_SESSIONS, sessionId);
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[DataImport] Error during extraction: ${errorMessage}`);

      await page.close();
      // Don't close browser — session should remain available for retry.

      // Release session back to pool even on error.
      if (usingPool) {
        await releasePooledSession(env.BROWSER_SESSIONS, sessionId);
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
        console.debug(
          `[RateLimit] Skipped (not available in dev): ${rateLimitError}`,
        );
      }
    }

    // Data import endpoint (requires API key)
    if (!validateApiKey(request, env)) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const authHeader = request.headers.get("Authorization") || "none";
      console.error(
        `[Auth] Failed authentication attempt - IP: ${ip}, Path: ${
          url.pathname
        }, Method: ${request.method}, Auth Header: ${
          authHeader ? "present" : "missing"
        }`,
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
        const playwrightServerUrl =
          env.PLAYWRIGHT_SERVER_URL || "http://localhost:3001";
        const body = await request.json();

        // Acquire a session from the pool for local Playwright too
        const poolResult = await acquirePooledSession(
          env.BROWSER_SESSIONS,
          env.BROWSER,
          body.sessionId,
          body.url,
        );

        if (!poolResult) {
          return new Response(
            JSON.stringify({
              error:
                "All browser sessions are currently busy. Please retry shortly.",
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
          const response = await fetch(
            `${playwrightServerUrl}/api/place-details`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...body,
                sessionId: poolResult.sessionId,
              }),
            },
          );

          const data = await response.json();

          // Release session back to pool
          await releasePooledSession(
            env.BROWSER_SESSIONS,
            poolResult.sessionId,
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
          );

          return new Response(
            JSON.stringify({ error: "Failed to extract place details" }),
            {
              status: 502,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }
      } else {
        // Production: use Cloudflare Browser Rendering with session pool.
        const body = (await request.json()) as { url?: string };
        const placeUrl = body.url;

        if (!placeUrl) {
          return new Response(
            JSON.stringify({ error: "Missing url parameter" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        }

        // Acquire a session from the pool.
        let poolSessionId: string;
        let browser: any;

        const poolResult = await acquirePooledSession(
          env.BROWSER_SESSIONS,
          env.BROWSER,
        );

        if (!poolResult) {
          return new Response(
            JSON.stringify({
              error:
                "All browser sessions are currently busy. Please retry shortly.",
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
          const msg =
            connectError instanceof Error
              ? connectError.message
              : String(connectError);
          console.error(
            `[PlaceDetails] Failed to connect to session ${poolSessionId}: ${msg}`,
          );

          // Dead session — clean up and retry once.
          await removePooledSession(env.BROWSER_SESSIONS, poolSessionId);

          const retryResult = await acquirePooledSession(
            env.BROWSER_SESSIONS,
            env.BROWSER,
          );

          if (!retryResult) {
            return new Response(
              JSON.stringify({
                error:
                  "All browser sessions are currently busy. Please retry shortly.",
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
          browser = await connect(env.BROWSER, poolSessionId);
          console.log(
            `[PlaceDetails] Connected to retry session ${poolSessionId}`,
          );
        }

        const page = await browser.newPage();

        try {
          // Strip @lat,lng,zoom/ from the URL to avoid inheriting stale viewport
          // coordinates from the collection page. This forces Google Maps to
          // recentre on the actual place location.
          const cleanUrl = placeUrl.replace(
            /\/@-?\d+\.?\d*,-?\d+\.?\d*,\d+\.?\d*z\//,
            "/",
          );
          console.log(`[PlaceDetails] Navigating to: ${cleanUrl}`);
          await page.goto(cleanUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });

          // Wait for place panel to load.
          await page.waitForSelector("h1", { timeout: 10000 });

          // Wait for the URL to update with coordinates.
          try {
            await page.waitForURL(/@-?\d+\.\d+,-?\d+\.\d+/, { timeout: 8000 });
          } catch (_) {
            console.log(
              "[PlaceDetails] URL did not update with coordinates, will try DOM fallback",
            );
          }

          // Brief settle delay to ensure secondary elements (status badges,
          // review counts) have rendered after the main content loads.
          await page.waitForTimeout(500);

          const details = await page.evaluate(() => {
            const url = window.location.href;

            // Extract coordinates from URL pattern @lat,lng,zoom.
            const coordMatch = url.match(
              /@(-?\d+\.\d+),(-?\d+\.\d+),(\d+\.?\d*)z/,
            );
            let lat = coordMatch ? parseFloat(coordMatch[1]) : null;
            let lng = coordMatch ? parseFloat(coordMatch[2]) : null;

            // Fallback: canonical link.
            if (lat === null || lng === null) {
              const canonical = (
                document.querySelector(
                  'link[rel="canonical"]',
                ) as HTMLLinkElement
              )?.href;
              if (canonical) {
                const m = canonical.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
                if (m) {
                  lat = parseFloat(m[1]);
                  lng = parseFloat(m[2]);
                }
              }
            }

            // Fallback: og:image meta tag.
            if (lat === null || lng === null) {
              const ogImage = (
                document.querySelector(
                  'meta[property="og:image"]',
                ) as HTMLMetaElement
              )?.content;
              if (ogImage) {
                const m = ogImage.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
                if (m) {
                  lat = parseFloat(m[1]);
                  lng = parseFloat(m[2]);
                }
              }
            }

            // Name.
            const name = document.querySelector("h1")?.textContent;

            // Type (category).
            const typeButton = document.querySelector(
              'button[jsaction*="category"]',
            );
            let type = typeButton?.textContent;
            if (!type) {
              const buttons = document.querySelectorAll("button");
              for (const btn of buttons) {
                const text = btn.textContent?.toLowerCase() || "";
                if (
                  text.includes("restaurant") ||
                  text.includes("cafe") ||
                  text.includes("shop") ||
                  text.includes("bar") ||
                  text.includes("hotel") ||
                  text.includes("museum") ||
                  text.includes("park") ||
                  text.includes("gallery") ||
                  text.includes("store")
                ) {
                  type = btn.textContent;
                  break;
                }
              }
            }

            // Address.
            let address = null;
            const addressButtons = document.querySelectorAll(
              'button[aria-label*="Address"], button[data-item-id="address"]',
            );
            for (const btn of addressButtons) {
              const label = btn.getAttribute("aria-label");
              if (label && label.includes("Address:")) {
                address = label.replace("Address:", "").trim();
                break;
              }
              const text = btn.textContent;
              if (text && text.length > 5 && text.length < 200) {
                address = text;
                break;
              }
            }

            // Website.
            let website = null;
            const websiteLinks = document.querySelectorAll(
              'a[data-item-id="authority"], a[aria-label*="Website"]',
            );
            for (const link of websiteLinks) {
              if (
                (link as HTMLAnchorElement).href &&
                !(link as HTMLAnchorElement).href.includes("google.com")
              ) {
                website = (link as HTMLAnchorElement).href;
                break;
              }
            }

            // Rating.
            const ratingImg = document.querySelector(
              '[role="img"][aria-label*="stars"]',
            );
            const ratingLabel = ratingImg?.getAttribute("aria-label");
            const ratingMatch = ratingLabel?.match(/(\d+\.?\d*)\s*stars?/i);
            const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

            // Review count.
            const reviewButtons = document.querySelectorAll(
              'button[aria-label*="reviews"], [aria-label*="Reviews"]',
            );
            let reviewCount = null;
            for (const btn of reviewButtons) {
              const label = btn.getAttribute("aria-label") || btn.textContent;
              const countMatch = label?.match(/(\d+)\s*reviews?/i);
              if (countMatch) {
                reviewCount = parseInt(countMatch[1]);
                break;
              }
            }

            // Business status (e.g. "Permanently closed", "Temporarily closed").
            let status = "operational";
            const statusEl = document.querySelector("span.fCEvvc");
            if (statusEl) {
              const statusText =
                statusEl.textContent?.trim().toLowerCase() || "";
              if (statusText.includes("permanently closed")) {
                status = "permanently_closed";
              } else if (statusText.includes("temporarily closed")) {
                status = "temporarily_closed";
              }
            }

            return {
              name,
              type,
              address,
              lat,
              lng,
              website,
              rating,
              review_count: reviewCount,
              status,
              google_maps_url: url.split("?")[0],
            };
          });

          await page.close();
          await releasePooledSession(env.BROWSER_SESSIONS, poolSessionId);

          console.log(
            `[PlaceDetails] Extracted: ${details.name} | coords={${details.lat}, ${details.lng}}`,
          );

          return new Response(
            JSON.stringify({ result: details, sessionId: poolSessionId }),
            {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[PlaceDetails] Error: ${msg}`);

          await page.close();
          await releasePooledSession(env.BROWSER_SESSIONS, poolSessionId);

          return new Response(
            JSON.stringify({ error: "Failed to extract place details" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders },
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
