/**
 * Page-level scraping functions used by the Browserli Worker.
 *
 * Each function takes a Playwright page and runs its extraction logic inside
 * the browser via page.evaluate(). They live in their own module so they can
 * be tested against fixture HTML in a real browser.
 */

import { normaliseGoogleMapsUrl } from "./utils";

export interface PlaceCard {
  name: string;
  url: string;
  rating?: number;
  reviewCount?: number;
  note?: string;
  savedAt?: number; // Unix timestamp (seconds) when place was saved to the collection.
  kgId?: string; // Google Knowledge Graph ID, e.g. "/g/11ltqq0zv9".
  photoUrl?: string; // First photo thumbnail URL from the collection blob.
  lat?: number; // Latitude from collection blob (more reliable than page extraction).
  lng?: number; // Longitude from collection blob.
}

/**
 * Capture debug information about the page structure.
 * Returns raw HTML and DOM analysis for troubleshooting selectors.
 */
export async function captureDebugInfo(
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
            tag: a.parentElement?.tagName.toLowerCase(),
            classes: a.parentElement?.className.slice(0, 100),
          },
        }));

      const analysis = {
        allLinks: document.querySelectorAll("a").length,
        mapsPlaceLinks: placeLinks.length,
        containers: {
          dataItemIdContainers: document.querySelectorAll("[data-item-id]").length,
          roleHeadings: document.querySelectorAll('[role="heading"]').length,
          roleNavigations: document.querySelectorAll('[role="navigation"]').length,
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

export interface CollectionPlaceData {
  savedAt?: number;
  kgId?: string;
  photoUrl?: string;
  lat?: number;
  lng?: number;
}

export interface CollectionBlobResult {
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
export async function extractCollectionBlobData(page: any): Promise<CollectionBlobResult> {
  try {
    const extracted: {
      entries: Array<{
        url: string;
        savedAt?: number;
        kgId?: string;
        photoUrl?: string;
        lat?: number;
        lng?: number;
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
      } catch {
        return { entries: [] };
      }

      (window as any).AF_initDataCallback = origFn;

      if (!capturedData?.[1] || !Array.isArray(capturedData[1])) {
        return { entries: [] };
      }

      // Collection-level metadata.
      const meta = capturedData[13];
      const totalCount = typeof meta?.[3] === "number" ? meta[3] : undefined;
      const collectionId = typeof meta?.[0] === "string" ? meta[0] : undefined;
      const collectionName = typeof meta?.[2] === "string" ? meta[2] : undefined;

      const entries: Array<{
        url: string;
        savedAt?: number;
        kgId?: string;
        photoUrl?: string;
        lat?: number;
        lng?: number;
      }> = [];

      let firstEntry = true;
      for (const place of capturedData[1]) {
        const url = place?.[5];
        if (typeof url !== "string" || !url) continue;

        const savedAtRaw = place?.[45]?.[0];
        const kgIdRaw = place?.[37]?.[5];
        const photoUrlRaw = place?.[43]?.[0]?.[0];

        // Coordinates: extract from the data parameter's !8m2!3d{lat}!4d{lng} fragment.
        // This encodes the actual place pin location set server-side by Google, and is
        // completely independent of the map viewport or the browser's geo-detected location.
        // The /@lat,lng,zoom/ portion of the URL is the VIEWPORT, not the pin — it reflects
        // the Cloudflare data-centre location when running in Browser Rendering, so we must
        // not use it.
        let lat: number | undefined;
        let lng: number | undefined;
        let coordSource = "none";

        const dataParamMatch = url.match(/!8m2!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
        if (dataParamMatch) {
          const la = parseFloat(dataParamMatch[1]);
          const ln = parseFloat(dataParamMatch[2]);
          if (!isNaN(la) && !isNaN(ln) && (la !== 0 || ln !== 0)) {
            lat = la;
            lng = ln;
            coordSource = "data-param";
          }
        }

        // Log the shape of the first entry to help diagnose any remaining issues.
        if (firstEntry) {
          firstEntry = false;
          const sample: Record<string, any> = {};
          for (let i = 0; i < Math.min((place as any[]).length, 50); i++) {
            const v = place[i];
            if (v !== null && v !== undefined) {
              sample[i] = typeof v === "object" ? JSON.stringify(v).slice(0, 120) : v;
            }
          }
          console.log(
            `[DataImport] Blob sample entry (coords: ${lat != null ? `${lat},${lng} via ${coordSource}` : "none"}): ${JSON.stringify(sample)}`,
          );
        }

        entries.push({
          url,
          savedAt: typeof savedAtRaw === "number" && savedAtRaw > 0 ? savedAtRaw : undefined,
          kgId: typeof kgIdRaw === "string" && kgIdRaw ? kgIdRaw : undefined,
          photoUrl: typeof photoUrlRaw === "string" && photoUrlRaw ? photoUrlRaw : undefined,
          lat,
          lng,
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
        lat: entry.lat,
        lng: entry.lng,
      });
    }

    console.log(`[DataImport] Extracted ${map.size} place records from AF_initDataCallback blob`);

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
 * Extract place data from cards on current page.
 * Returns structured data from visible place cards ONLY on current viewport.
 */
export async function extractPlaceCardsFromPage(page: any): Promise<PlaceCard[]> {
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
          if (!href || !href.includes("/maps/place/")) return;

          const fullText = link.textContent?.trim() || "";
          if (!fullText || fullText.length < 3) return;

          // Parse: "Place Name4.5(88)", "Place Name4.3(2,596)" or "Place Name4.2(1.51K)"
          // -> name, rating, reviews.
          const match = fullText.match(/^(.+?)(\d+\.?\d*)\((\d[\d,]*\.?\d*K?)\)$/);
          let name = fullText;
          let rating: number | undefined;
          let reviewCount: number | undefined;

          if (match) {
            name = match[1].trim();
            if (match[2]) rating = parseFloat(match[2]);
            if (match[3]) {
              const countStr = match[3].replace(/,/g, "");
              if (countStr.endsWith("K")) {
                reviewCount = Math.round(parseFloat(countStr.slice(0, -1)) * 1000);
              } else {
                reviewCount = parseInt(countStr);
              }
            }
          }

          // Fallback cleanup for any remaining rating/review suffixes.
          name = name.replace(/\d+\.?\d*\s*\(\d[\d,]*\.?\d*K?\)$/, "").trim();
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
        } catch {
          // Silently skip malformed entries.
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
export async function getPaginationInfo(page: any): Promise<{ total: number; hasNext: boolean }> {
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
 * Details extracted from a single Google Maps place page.
 */
export interface PlaceDetails {
  name: string | null | undefined;
  type: string | null | undefined;
  address: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  status: string;
  google_maps_url: string;
}

/**
 * Extract place details from a Google Maps place page.
 *
 * Pre-extracted coordinates (from the URL data parameter) take precedence;
 * JSON-LD structured data is used as a fallback when they are absent.
 */
export async function extractPlaceDetails(
  page: any,
  preExtractedLat: number | null,
  preExtractedLng: number | null,
): Promise<PlaceDetails> {
  return page.evaluate(
    ({
      preExtractedLat,
      preExtractedLng,
    }: {
      preExtractedLat: number | null;
      preExtractedLng: number | null;
    }) => {
      const url = window.location.href;

      // Use pre-resolved coordinates from the URL data parameter when available.
      let lat: number | null = preExtractedLat;
      let lng: number | null = preExtractedLng;

      // Fallback: JSON-LD structured data. Only present on initial server-rendered
      // loads, not SPA navigations, but worth attempting when data param is absent.
      if (lat === null || lng === null) {
        const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of jsonLdScripts) {
          try {
            const data = JSON.parse(script.textContent || "");
            const geo = data?.geo ?? data?.location?.geo;
            const rawLat = geo?.latitude;
            const rawLng = geo?.longitude;
            if (rawLat != null && rawLng != null) {
              const parsedLat = typeof rawLat === "number" ? rawLat : parseFloat(rawLat);
              const parsedLng = typeof rawLng === "number" ? rawLng : parseFloat(rawLng);
              if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
                lat = parsedLat;
                lng = parsedLng;
                break;
              }
            }
          } catch {
            // Ignore malformed JSON-LD.
          }
        }
      }

      // Name.
      const name = document.querySelector("h1")?.textContent;

      // Type (category).
      const typeButton = document.querySelector('button[jsaction*="category"]');
      let type = typeButton?.textContent;
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
      const ratingImg = document.querySelector('[role="img"][aria-label*="stars"]');
      const ratingLabel = ratingImg?.getAttribute("aria-label");
      const ratingMatch = ratingLabel?.match(/(\d+\.?\d*)\s*stars?/i);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      // Review count. Only read from the place header (the block holding the
      // star rating): review counts elsewhere on the page, such as the
      // Directory or "People also search for" sections, belong to other
      // places. Google omits the count from the header for signed-out
      // visitors, in which case this stays null.
      let reviewCount = null;
      const ratingHeader = ratingImg?.closest(".F7nice") ?? ratingImg?.parentElement?.parentElement;
      const reviewEls = ratingHeader?.querySelectorAll("[aria-label]") ?? [];
      for (const el of reviewEls) {
        const label = el.getAttribute("aria-label") || "";
        // Counts use thousands separators, e.g. "1,234 reviews".
        const countMatch = label.match(/(\d[\d,]*)\s*reviews?/i);
        if (countMatch) {
          reviewCount = parseInt(countMatch[1].replace(/,/g, ""), 10);
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
    },
    { preExtractedLat, preExtractedLng },
  );
}
