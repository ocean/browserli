/**
 * Shared utility functions used by the Browserli Worker.
 *
 * Extracted into their own module so they can be unit-tested independently
 * of the full Worker handler.
 */

/**
 * Validate that a URL is a Google Maps collection/place URL to prevent SSRF attacks.
 */
export function isValidGoogleMapsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow https.
    if (parsed.protocol !== "https:") {
      return false;
    }

    // Allow google.com domain with /maps/, /collections/, or /placelists/ paths.
    if (parsed.hostname === "google.com" || parsed.hostname.endsWith(".google.com")) {
      const path = parsed.pathname;
      if (
        path.includes("/maps/") ||
        path.includes("/collections/") ||
        path.includes("/placelists/")
      ) {
        return true;
      }
    }

    // Also allow maps.app.goo.gl short URLs.
    if (parsed.hostname === "maps.app.goo.gl") {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
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
 * Validate API key from request headers using constant-time comparison.
 */
export function validateApiKey(request: Request, env: { API_KEYS: string }): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return false;
  }

  const allowedKeys = env.API_KEYS.split(",").map((k) => k.trim());

  for (const key of allowedKeys) {
    if (timingSafeEqual(token, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalise a Google Maps URL for matching.
 * Strips query strings and decodes unicode escapes so URLs from the
 * AF_initDataCallback blob can be matched against DOM-scraped hrefs.
 */
export function normaliseGoogleMapsUrl(url: string): string {
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
