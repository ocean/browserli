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
export function validateApiKey(
  request: Request,
  env: { API_KEYS: string },
): boolean {
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
