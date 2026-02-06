import { launch, connect, acquire } from "@cloudflare/playwright";

interface Env {
  BROWSER: any;
  API_KEYS: string;
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
}

interface PageInfo {
  startIndex: number;
  endIndex: number;
  totalCount: number;
  hasNextPage: boolean;
}

interface DataImportResponse {
  success: boolean;
  collectionUrl: string;
  sessionId: string;
  places: PlaceCard[];
  pageInfo: PageInfo;
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
const EXTRACTION_TIMEOUT = 10000;
const POLL_INTERVAL = 500; // ms between polls during pagination

/**
 * Validate API key from request headers.
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
  return allowedKeys.includes(token);
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
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Capture debug information about the page structure.
 * Returns raw HTML and DOM analysis for troubleshooting selectors.
 */
async function captureDebugInfo(page: any): Promise<{ htmlContent: string; domStructure: string }> {
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
        allLinks: document.querySelectorAll('a').length,
        mapsPlaceLinks: placeLinks.length,
        containers: {
          dataItemIdContainers: document.querySelectorAll('[data-item-id]').length,
          roleHeadings: document.querySelectorAll('[role="heading"]').length,
          roleNavigations: document.querySelectorAll('[role="navigation"]').length,
          buttons: document.querySelectorAll('button').length,
        },
        samplePlaceLinks,
        htmlSnippet: html.slice(Math.max(0, html.indexOf('<div role="main">')), Math.max(0, html.indexOf('<div role="main">')) + 2000),
      };
      
      return [html, JSON.stringify(analysis, null, 2)];
    });

    return { htmlContent, domStructure };
  } catch (error) {
    console.error('[DataImport] Error capturing debug info:', error);
    return { htmlContent: '', domStructure: '' };
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
      const placeLinks = document.querySelectorAll('a[href*="/maps/place/"][class*="ir"]');
      
      placeLinks.forEach((link) => {
        try {
          const href = (link as HTMLAnchorElement).href;
          if (!href || !href.includes('/maps/place/')) return;

          const fullText = link.textContent?.trim() || '';
          if (!fullText || fullText.length < 3) return;

          // Parse: "Place Name4.5(88)" -> name="Place Name", rating=4.5, reviews=88
          const match = fullText.match(/^(.+?)(\d+\.?\d*)?\(?(\d+)\)?$/);
          let name = fullText;
          let rating: number | undefined;
          let reviewCount: number | undefined;

          if (match) {
            name = match[1].trim();
            if (match[2]) rating = parseFloat(match[2]);
            if (match[3]) reviewCount = parseInt(match[3]);
          }

          name = name.replace(/\d+\.?\d*\s*\(\d+\)$/, '').trim();
          if (!name || name.length < 2) return;

          placeCards.push({ name, url: href, rating, reviewCount });
        } catch (e) {
          // Silently skip malformed entries
        }
      });

      return placeCards;
    });

    return places;
  } catch (error) {
    console.error('[DataImport] Error extracting place cards:', error);
    return [];
  }
}

/**
 * Get pagination info from current page.
 * Returns total count and whether next page is available.
 */
async function getPaginationInfo(page: any): Promise<{ total: number; hasNext: boolean }> {
  try {
    return await page.evaluate(() => {
      // Look for pagination text like "1-200 of 237"
      const paginationEls = document.querySelectorAll('[role="navigation"], .Azx0Fe, [aria-label*="pagination"]');
      
      let total = 0;
      let hasNext = false;

      for (const el of paginationEls) {
        const text = el.textContent || '';
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
      const nextButton = document.querySelector('button[aria-label*="Next"], [aria-label*="next page"]') as HTMLButtonElement;
      if (nextButton) {
        hasNext = !nextButton.hasAttribute('disabled');
      }

      return { total, hasNext };
    });
  } catch (error) {
    console.error('[DataImport] Error getting pagination info:', error);
    return { total: 0, hasNext: false };
  }
}

/**
 * Click the next button to navigate to the next page.
 */
async function goToNextPage(page: any): Promise<boolean> {
  try {
    const nextButton = await page.$('button[aria-label*="Next page"], button[aria-label*="next"]');
    
    if (!nextButton) {
      console.log('[DataImport] No next button found');
      return false;
    }

    const isDisabled = await nextButton.getAttribute('disabled');
    if (isDisabled !== null) {
      console.log('[DataImport] Next button is disabled');
      return false;
    }

    console.log('[DataImport] Clicking next button...');
    
    // Get initial place count to detect when page changes
    const initialCount = await page.evaluate(() => {
      return document.querySelectorAll('a[href*="/maps/place/"][class*="ir"]').length;
    });
    console.log(`[DataImport] Initial card count: ${initialCount}`);

    await nextButton.click();

    // Wait for the page to load new content by polling for DOM changes
    let pageChanged = false;
    let attempts = 0;
    const maxAttempts = Math.ceil(NAVIGATION_TIMEOUT / POLL_INTERVAL);

    while (!pageChanged && attempts < maxAttempts) {
      await page.waitForTimeout(POLL_INTERVAL);
      
      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="/maps/place/"][class*="ir"]').length;
      });

      // Page has changed if the count is different (new content loaded)
      if (currentCount !== initialCount) {
        pageChanged = true;
        console.log(`[DataImport] Page changed detected. Old count: ${initialCount}, New count: ${currentCount}`);
      }

      attempts++;
    }

    if (!pageChanged) {
      console.log('[DataImport] Warning: page did not change after clicking next button');
    }

    // Scroll to top to ensure we're at the start of the new page
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });

    return true;
  } catch (error) {
    console.error('[DataImport] Error navigating to next page:', error);
    return false;
  }
}

/**
 * Data import handler - extracts place URLs from a Google Maps collection.
 * Handles pagination and returns batches of places.
 */
async function handleDataImport(
  request: Request,
  env: Env,
): Promise<Response> {
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

    // Validate URL
    if (
      !body.url.includes("google.com/collections") &&
      !body.url.includes("maps.app.goo.gl")
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid URL: must be a Google Maps collection",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Use session reuse if sessionId provided, otherwise start new session
    let browser: any;
    let sessionId: string;

    if (body.sessionId) {
      console.log(`[DataImport] Reusing session: ${body.sessionId}`);
      try {
        browser = await connect(env.BROWSER, body.sessionId);
        sessionId = body.sessionId;
        console.log(`[DataImport] Successfully reused session`);
      } catch (connectError) {
        const msg = connectError instanceof Error ? connectError.message : String(connectError);
        console.error(`[DataImport] Failed to reuse session: ${msg}`);
        console.log(`[DataImport] Session may have expired, creating new one`);
        const session = await acquire(env.BROWSER);
        sessionId = session.sessionId;
        console.log(`[DataImport] New session ID: ${sessionId}`);
        browser = await connect(env.BROWSER, sessionId);
      }
    } else {
      console.log('[DataImport] Creating new browser session');
      try {
        const session = await acquire(env.BROWSER);
        sessionId = session.sessionId;
        console.log(`[DataImport] New session ID: ${sessionId}`);
        browser = await connect(env.BROWSER, sessionId);
      } catch (acquireError) {
        const msg = acquireError instanceof Error ? acquireError.message : String(acquireError);
        console.error(`[DataImport] Browser acquisition failed: ${msg}`);
        // Check if this is a rate limit error
        if (msg.includes('429') || msg.includes('Rate limit')) {
          console.error('[DataImport] RATE LIMIT DETECTED - This is from Cloudflare Browser Rendering API');
          throw new Error(`Browser service rate limited. Please wait before retrying. Error: ${msg}`);
        }
        throw acquireError;
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
      // Load collection page
      console.log(`[DataImport] Loading collection: ${body.url}`);
      await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });

      // If resuming pagination, navigate to correct page
      if (pageNum > 0) {
        console.log(`[DataImport] Resuming from page ${pageNum + 1}`);
        for (let i = 0; i < pageNum; i++) {
          const hasNext = await goToNextPage(page);
          if (!hasNext) {
            console.log(`[DataImport] Could not reach page ${i + 1}`);
            break;
          }
          await page.waitForTimeout(1000);
        }
      }

      // Extract places from current page
      console.log(`[DataImport] Extracting places from page ${pageNum + 1}...`);
      const places = await extractPlaceCardsFromPage(page);
      
      if (places.length === 0) {
        console.log('[DataImport] No places found on current page');
      } else {
        console.log(`[DataImport] Found ${places.length} places on page ${pageNum + 1}`);
        allPlaces.push(...places);
      }

      // Get pagination info
      const { total, hasNext } = await getPaginationInfo(page);
      totalCount = total;

      console.log(
        `[DataImport] Pagination info: total=${total}, hasNext=${hasNext}, itemsExtracted=${places.length}`,
      );

      // Capture debug info if requested
      let debugInfo: { htmlContent: string; domStructure: string } | undefined;
      if (body.debug) {
        console.log('[DataImport] Capturing debug information...');
        debugInfo = await captureDebugInfo(page);
      }

      await page.close();
      // Don't close browser - just disconnect so session can be reused
      // The session stays alive for ~10 minutes on the Browserli service

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
      // Don't close browser - session should remain available for retry

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
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("[Worker] Data import error:", errorMessage);

    const isRateLimit = errorMessage.includes('429') || errorMessage.includes('Rate limit') || errorMessage.includes('rate limited');
    const statusCode = isRateLimit ? 429 : 500;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isRateLimit) {
      headers["Retry-After"] = "120"; // Suggest 2 minute retry
      console.error("[Worker] CLOUDFLARE BROWSER RENDERING RATE LIMITED - Check browserli logs for details");
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: errorMessage,
        isRateLimit,
      }),
      { status: statusCode, headers },
    );
  }
}

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

    // Data import endpoint (requires API key)
    if (!validateApiKey(request, env)) {
      if (url.pathname !== "/" && request.method === "GET") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/" },
        });
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: "Unauthorized: invalid or missing API key",
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

    return new Response(
      JSON.stringify({
        error: "Not found",
        available: ["/data-import"],
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  },
};
