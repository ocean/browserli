#!/usr/bin/env node

/**
 * Local Playwright Server
 *
 * Starts a Playwright server on a fixed port (3000) for local development.
 *
 * Usage: node playwright-server.js
 *
 * The WebSocket endpoint will be: ws://localhost:3000/[token]
 * Update .env.local with: PLAYWRIGHT_SERVER_URL=ws://localhost:3000/[token]
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { URL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_PORT = 3000;
const HTTP_PORT = 3001;

// Store active pages keyed by sessionId
const activeSessions = new Map();

async function startServer() {
  console.log("🎭 Starting Playwright server...");

  try {
    const server = await chromium.launchServer({
      port: FIXED_PORT,
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });

    const wsEndpoint = server.wsEndpoint();

    // Also start HTTP API server for Worker-friendly proxy
    startHttpApiServer(server);

    console.log("");
    console.log("✅ Playwright server started");
    console.log(`📡 CDP WebSocket endpoint: ${wsEndpoint}`);
    console.log(`📡 HTTP API endpoint: http://localhost:${HTTP_PORT}`);
    console.log("");
    console.log("⚠️  Update .env.local with:");
    console.log(`PLAYWRIGHT_SERVER_URL=http://localhost:${HTTP_PORT}`);
    console.log("");
    console.log("Then restart wrangler dev:");
    console.log("npm run wrangler:dev");
    console.log("");
    console.log("Press Ctrl+C to stop the server");
    console.log("");

    // Handle graceful shutdown
    const cleanup = async () => {
      console.log("\n");
      console.log("🛑 Shutting down Playwright server...");
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (error) {
    console.error("❌ Failed to start Playwright server:", error);
    process.exit(1);
  }
}

function startHttpApiServer(playwrightServer) {
  const httpServer = createServer(async (req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Collect request body
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        let data = {};
        if (body) {
          data = JSON.parse(body);
        }

        if (pathname === "/api/page/goto") {
          const sessionId = data.sessionId || `session-${Date.now()}`;

          if (!activeSessions.has(sessionId)) {
            const browser = await chromium.connect(
              playwrightServer.wsEndpoint(),
            );
            const context = await browser.newContext();
            const page = await context.newPage();
            activeSessions.set(sessionId, {
              browser,
              context,
              page,
              createdAt: Date.now(),
            });
          }

          const { page } = activeSessions.get(sessionId);
          console.log(`[HTTP API] goto: ${data.url}`);
          // Add default 30 second timeout if not specified
          const gotoOptions = {
            waitUntil: "domcontentloaded",
            timeout: 30000,
            ...data.options,
          };
          await page.goto(data.url, gotoOptions);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, sessionId }));
        } else if (pathname === "/api/page/evaluate") {
          const sessionId = data.sessionId;

          if (!sessionId || !activeSessions.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
            return;
          }

          const { page } = activeSessions.get(sessionId);

          try {
            // The script is a function as a string (from fn.toString())
            // Convert it to an actual function and execute it
            // eslint-disable-next-line no-eval
            const fn = eval(`(${data.script})`);
            // Add 10 second timeout to prevent hanging requests
            const result = await Promise.race([
              page.evaluate(fn),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Evaluation timeout: exceeded 10 seconds")), 10000)
              )
            ]);

            const resultType = Array.isArray(result)
              ? `${result.length} items`
              : `${typeof result}${result !== null && typeof result === 'object' ? ` (object)` : ''}`;
            console.log(
              `[HTTP API] evaluate returned ${resultType}`,
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result, sessionId }));
          } catch (evalError) {
            console.error(`[HTTP API] evaluate error:`, evalError.message);
            console.error(
              `[HTTP API] Script was:`,
              data.script.substring(0, 200),
            );
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: evalError.message }));
          }
        } else if (pathname === "/api/place-details") {
          let sessionId = data.sessionId;
          const placeUrl = data.url;
          let autoCreated = false;

          if (!placeUrl) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing url parameter" }));
            return;
          }

          // Auto-create session if none provided or if the provided one is expired.
          if (!sessionId || !activeSessions.has(sessionId)) {
            sessionId = `place-detail-${Date.now()}`;
            console.log(
              `[HTTP API] place-details: auto-creating session ${sessionId}`,
            );
            const browser = await chromium.connect(
              playwrightServer.wsEndpoint(),
            );
            const context = await browser.newContext();
            const page = await context.newPage();
            activeSessions.set(sessionId, {
              browser,
              context,
              page,
              createdAt: Date.now(),
            });
            autoCreated = true;
          }

          const { page } = activeSessions.get(sessionId);

          try {
            // Strip @lat,lng,zoom/ from the URL to avoid inheriting stale viewport
            // coordinates from the collection page. This forces Google Maps to
            // recentre on the actual place location.
            const cleanUrl = placeUrl.replace(
              /\/@-?\d+\.?\d*,-?\d+\.?\d*,\d+\.?\d*z\//,
              "/",
            );
            console.log(`[HTTP API] place-details: ${cleanUrl}`);
            await page.goto(cleanUrl, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });

            // Wait for place panel to load.
            await page.waitForSelector("h1", { timeout: 10000 });

            // Wait for the URL to update with coordinates.
            // Google Maps rewrites the URL after the map centres on the place,
            // which happens after the initial DOM content loads.
            try {
              await page.waitForURL(/@-?\d+\.\d+,-?\d+\.\d+/, {
                timeout: 8000,
              });
            } catch (_) {
              console.log(
                "[place-details] URL did not update with coordinates, will try DOM fallback",
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

              // Fallback: try the canonical link (Google Maps often includes coords there).
              if (lat === null || lng === null) {
                const canonical = document.querySelector(
                  'link[rel="canonical"]',
                )?.href;
                if (canonical) {
                  const canonicalMatch = canonical.match(
                    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
                  );
                  if (canonicalMatch) {
                    lat = parseFloat(canonicalMatch[1]);
                    lng = parseFloat(canonicalMatch[2]);
                  }
                }
              }

              // Fallback: try og:image meta tag which can contain centre coordinates.
              if (lat === null || lng === null) {
                const ogImage = document.querySelector(
                  'meta[property="og:image"]',
                )?.content;
                if (ogImage) {
                  const centerMatch = ogImage.match(
                    /center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/,
                  );
                  if (centerMatch) {
                    lat = parseFloat(centerMatch[1]);
                    lng = parseFloat(centerMatch[2]);
                  }
                }
              }

              // Name
              const name = document.querySelector("h1")?.textContent;

              // Type (category)
              const typeButton = document.querySelector(
                'button[jsaction*="category"]',
              );
              let type = typeButton?.textContent;

              // Fallback: try to find type near the rating
              if (!type) {
                const buttons = document.querySelectorAll("button");
                for (const btn of buttons) {
                  const text = btn.textContent?.toLowerCase() || "";
                  // Skip "Nearby restaurants", "Nearby hotels", etc. — these are
                  // navigation buttons further down the page, not the place category.
                  if (text.startsWith("nearby")) continue;
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

              // Address
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

              // Website
              let website = null;
              const websiteLinks = document.querySelectorAll(
                'a[data-item-id="authority"], a[aria-label*="Website"]',
              );
              for (const link of websiteLinks) {
                if (link.href && !link.href.includes("google.com")) {
                  website = link.href;
                  break;
                }
              }

              // Rating
              const ratingImg = document.querySelector(
                '[role="img"][aria-label*="stars"]',
              );
              const ratingLabel = ratingImg?.getAttribute("aria-label");
              const ratingMatch = ratingLabel?.match(/(\d+\.?\d*)\s*stars?/i);
              const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

              // Review count
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
                const statusText = statusEl.textContent?.trim().toLowerCase() || "";
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

            // Clean up auto-created sessions after use.
            if (autoCreated) {
              const session = activeSessions.get(sessionId);
              if (session) {
                await session.page.close();
                await session.context.close();
                await session.browser.close();
                activeSessions.delete(sessionId);
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: details, sessionId }));
          } catch (detailsError) {
            console.error(
              `[HTTP API] place-details error:`,
              detailsError.message,
            );

            // Clean up auto-created sessions on error too.
            if (autoCreated) {
              const session = activeSessions.get(sessionId);
              if (session) {
                try {
                  await session.page.close();
                  await session.context.close();
                  await session.browser.close();
                } catch (_) {}
                activeSessions.delete(sessionId);
              }
            }

            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: detailsError.message }));
          }
        } else if (pathname === "/api/page/close") {
          const sessionId = data.sessionId;
          if (sessionId && activeSessions.has(sessionId)) {
            const { browser, context, page } = activeSessions.get(sessionId);
            await page.close();
            await context.close();
            await browser.close();
            activeSessions.delete(sessionId);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      } catch (error) {
        console.error("[HTTP API] Error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(
      `📡 HTTP API server listening on http://localhost:${HTTP_PORT}`,
    );
  });
}

startServer();
