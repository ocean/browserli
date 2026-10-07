/**
 * Real-browser tests for the page-level scrapers.
 *
 * These run headless Chrome through the local Browser Rendering binding that
 * miniflare provides for `env.BROWSER`, driven by @cloudflare/playwright, the
 * same client the Worker uses in production. Google Maps responses are
 * replaced with fixture HTML via page.route(), so no real network requests
 * are made.
 *
 * On first run, miniflare downloads Chrome for Testing into the wrangler cache
 * (~145 MB), which can take a while.
 */

import { env } from "cloudflare:test";
import { connect, launch, type Browser, type Page } from "@cloudflare/playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureDebugInfo,
  extractCollectionBlobData,
  extractPlaceCardsFromPage,
  extractPlaceDetails,
  getPaginationInfo,
} from "../src/page-extractors";
import { acquirePooledSession, releasePooledSession } from "../src/session-pool";

const COLLECTION_URL = "https://www.google.com/collections/s/list/abc123";
const PLACE_URL = "https://www.google.com/maps/place/Cafe+One/data=!4m2!3m1!1s0x1:0x2";

const CAFE_ONE_URL = "https://www.google.com/maps/place/Cafe+One/data=!4m2!3m1!1s0x1:0x2";
const BIG_MUSEUM_URL =
  "https://www.google.com/maps/place/Big+Museum/data=!4m2!3m1!1s0x3:0x4!8m2!3d-31.9523!4d115.8613";

/**
 * Build a place entry for the AF_initDataCallback blob, with values at the
 * array indices the extractor reads.
 */
function blobPlace(fields: {
  url: string;
  kgId?: string;
  photoUrl?: string;
  savedAt?: number;
}): unknown[] {
  const place: unknown[] = new Array(46).fill(null);
  place[5] = fields.url;
  if (fields.kgId) place[37] = [null, null, null, null, null, fields.kgId];
  if (fields.photoUrl) place[43] = [[fields.photoUrl]];
  if (fields.savedAt) place[45] = [fields.savedAt];
  return place;
}

/**
 * Build a collection page resembling a Google Maps saved list.
 */
function collectionPageHtml(options: { nextDisabled?: boolean } = {}): string {
  const data: unknown[] = new Array(14).fill(null);
  data[1] = [
    blobPlace({
      url: CAFE_ONE_URL,
      kgId: "/g/11cafe0001",
      photoUrl: "https://lh3.googleusercontent.com/cafe-one.jpg",
      savedAt: 1_760_000_000,
    }),
    blobPlace({ url: BIG_MUSEUM_URL }),
  ];
  data[13] = ["collection-id-123", null, "Perth favourites", 237];

  return `<!DOCTYPE html>
<html>
<head>
  <script class="ds:0">AF_initDataCallback({key: 'ds:0', data: ${JSON.stringify(data)}});</script>
</head>
<body>
  <div role="main">
    <div class="TOmvfe">
      <a class="ir" href="${CAFE_ONE_URL}">Cafe One4.5(88)</a>
      <span role="textbox" aria-label="Best flat white in town">Best flat white…</span>
    </div>
    <div class="TOmvfe">
      <a class="ir" href="${BIG_MUSEUM_URL}">Big Museum4.2(1.51K)</a>
    </div>
    <a class="ir" href="https://www.google.com/maps/place/No+Rating/data=!4m2">No Rating Place</a>
    <a class="other" href="https://www.google.com/maps/place/Ignored/data=!4m2">Ignored link</a>
  </div>
  <div role="navigation">1-200 of 237</div>
  <button aria-label="Next page"${options.nextDisabled ? " disabled" : ""}>Next</button>
</body>
</html>`;
}

/**
 * Serve fixture HTML for every request to www.google.com, then navigate.
 */
async function gotoFixture(page: Page, url: string, html: string): Promise<void> {
  await page.route("https://www.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

describe("page extractors in a real browser", { timeout: 60_000 }, () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launch(env.BROWSER as any);
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  describe("extractCollectionBlobData", () => {
    it("extracts per-place data and collection metadata from the blob", async () => {
      await gotoFixture(page, COLLECTION_URL, collectionPageHtml());

      const result = await extractCollectionBlobData(page);

      expect(result.collectionId).toBe("collection-id-123");
      expect(result.collectionName).toBe("Perth favourites");
      expect(result.totalCount).toBe(237);
      expect(result.places.size).toBe(2);
      expect(result.places.get("/maps/place/Cafe+One/data=!4m2!3m1!1s0x1:0x2")).toEqual({
        savedAt: 1_760_000_000,
        kgId: "/g/11cafe0001",
        photoUrl: "https://lh3.googleusercontent.com/cafe-one.jpg",
        lat: undefined,
        lng: undefined,
      });
    });

    it("reads pin coordinates from the !8m2!3d…!4d… data parameter", async () => {
      await gotoFixture(page, COLLECTION_URL, collectionPageHtml());

      const result = await extractCollectionBlobData(page);
      const museum = result.places.get(new URL(BIG_MUSEUM_URL).pathname);

      expect(museum?.lat).toBe(-31.9523);
      expect(museum?.lng).toBe(115.8613);
    });

    it("returns an empty map when the page has no data blob", async () => {
      await gotoFixture(page, COLLECTION_URL, "<html><body><h1>Nothing here</h1></body></html>");

      const result = await extractCollectionBlobData(page);

      expect(result.places.size).toBe(0);
      expect(result.totalCount).toBeUndefined();
    });
  });

  describe("extractPlaceCardsFromPage", () => {
    it("parses names, ratings, review counts and notes from place cards", async () => {
      await gotoFixture(page, COLLECTION_URL, collectionPageHtml());

      const cards = await extractPlaceCardsFromPage(page);

      expect(cards).toEqual([
        {
          name: "Cafe One",
          url: CAFE_ONE_URL,
          rating: 4.5,
          reviewCount: 88,
          note: "Best flat white in town",
        },
        {
          name: "Big Museum",
          url: BIG_MUSEUM_URL,
          rating: 4.2,
          reviewCount: 1510,
          note: undefined,
        },
        {
          name: "No Rating Place",
          url: "https://www.google.com/maps/place/No+Rating/data=!4m2",
          rating: undefined,
          reviewCount: undefined,
          note: undefined,
        },
      ]);
    });
  });

  describe("getPaginationInfo", () => {
    it("reads the total and detects an enabled next button", async () => {
      await gotoFixture(page, COLLECTION_URL, collectionPageHtml());

      expect(await getPaginationInfo(page)).toEqual({ total: 237, hasNext: true });
    });

    it("reports no next page when the next button is disabled", async () => {
      await gotoFixture(page, COLLECTION_URL, collectionPageHtml({ nextDisabled: true }));

      expect(await getPaginationInfo(page)).toEqual({ total: 237, hasNext: false });
    });
  });

  describe("captureDebugInfo", () => {
    it("summarises the page structure", async () => {
      await gotoFixture(page, COLLECTION_URL, collectionPageHtml());

      const { htmlContent, domStructure } = await captureDebugInfo(page);
      const analysis = JSON.parse(domStructure);

      expect(htmlContent).toContain("Perth favourites");
      expect(analysis.mapsPlaceLinks).toBe(4);
      expect(analysis.containers.roleNavigations).toBe(1);
    });
  });

  describe("extractPlaceDetails", () => {
    const placeHtml = (extraHead = "", status = ""): string => `<!DOCTYPE html>
<html>
<head>${extraHead}</head>
<body>
  <h1>Cafe One</h1>
  ${status}
  <div role="img" aria-label="4.6 stars"></div>
  <button aria-label="88 reviews">(88)</button>
  <button jsaction="pane.rating.category">Café</button>
  <button data-item-id="address" aria-label="Address: 1 Test Street, Perth WA 6000">1 Test Street</button>
  <a data-item-id="authority" href="https://cafe-one.example/">cafe-one.example</a>
  <button>Nearby restaurants</button>
</body>
</html>`;

    it("extracts the place fields and prefers pre-extracted coordinates", async () => {
      const jsonLd = `<script type="application/ld+json">{"geo": {"latitude": 1, "longitude": 2}}</script>`;
      await gotoFixture(page, `${PLACE_URL}?entry=ttu`, placeHtml(jsonLd));

      const details = await extractPlaceDetails(page, -31.95, 115.86);

      expect(details).toEqual({
        name: "Cafe One",
        type: "Café",
        address: "1 Test Street, Perth WA 6000",
        lat: -31.95,
        lng: 115.86,
        website: "https://cafe-one.example/",
        rating: 4.6,
        review_count: 88,
        status: "operational",
        google_maps_url: PLACE_URL,
      });
    });

    it("falls back to JSON-LD coordinates when none are pre-extracted", async () => {
      const jsonLd = `<script type="application/ld+json">{"geo": {"latitude": "-31.9505", "longitude": "115.8605"}}</script>`;
      await gotoFixture(page, PLACE_URL, placeHtml(jsonLd));

      const details = await extractPlaceDetails(page, null, null);

      expect(details.lat).toBe(-31.9505);
      expect(details.lng).toBe(115.8605);
    });

    it("detects a permanently closed place", async () => {
      await gotoFixture(
        page,
        PLACE_URL,
        placeHtml("", `<span class="fCEvvc">Permanently closed</span>`),
      );

      const details = await extractPlaceDetails(page, null, null);

      expect(details.status).toBe("permanently_closed");
      expect(details.lat).toBeNull();
    });
  });
});

describe("session pool with a real browser session", { timeout: 60_000 }, () => {
  it("acquires, connects to, releases and reuses a browser session", async () => {
    const options = { maxSessions: 1, keepAliveMs: 60_000 };

    const first = await acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      undefined,
      COLLECTION_URL,
      options,
    );
    expect(first).not.toBeNull();
    expect(first!.reused).toBe(false);

    const browser = await connect(env.BROWSER as any, first!.sessionId);
    const page = await browser.newPage();
    await page.setContent("<h1>Pooled</h1>");
    expect(await page.textContent("h1")).toBe("Pooled");
    await page.close();
    // Disconnects without killing the session, as the Worker does.
    await browser.close();

    await releasePooledSession(env.BROWSER_SESSIONS, first!.sessionId, options.keepAliveMs);

    const second = await acquirePooledSession(
      env.BROWSER_SESSIONS,
      env.BROWSER,
      undefined,
      COLLECTION_URL,
      options,
    );
    expect(second).toEqual({ sessionId: first!.sessionId, reused: true });

    const reconnected = await connect(env.BROWSER as any, second!.sessionId);
    const reusedPage = await reconnected.newPage();
    await reusedPage.setContent("<p>Still alive</p>");
    expect(await reusedPage.textContent("p")).toBe("Still alive");
    await reusedPage.close();
    await reconnected.close();
  });
});
