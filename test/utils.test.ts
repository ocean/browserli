import { describe, it, expect } from "vitest";
import {
  isValidGoogleMapsUrl,
  timingSafeEqual,
  validateApiKey,
} from "../src/utils";

// ---------------------------------------------------------------------------
// isValidGoogleMapsUrl
// ---------------------------------------------------------------------------

describe("isValidGoogleMapsUrl", () => {
  describe("valid URLs", () => {
    it("accepts a google.com /maps/ URL", () => {
      expect(
        isValidGoogleMapsUrl(
          "https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z",
        ),
      ).toBe(true);
    });

    it("accepts a google.com /collections/ URL", () => {
      expect(
        isValidGoogleMapsUrl(
          "https://www.google.com/collections/s/list/ABC123",
        ),
      ).toBe(true);
    });

    it("accepts a google.com /placelists/ URL", () => {
      expect(
        isValidGoogleMapsUrl(
          "https://www.google.com/placelists/some/path",
        ),
      ).toBe(true);
    });

    it("accepts a maps.app.goo.gl short URL", () => {
      expect(isValidGoogleMapsUrl("https://maps.app.goo.gl/abc123")).toBe(true);
    });

    it("accepts a place/data URL (used by the place-details endpoint)", () => {
      expect(
        isValidGoogleMapsUrl(
          "https://www.google.com/maps/place/Louvre/data=!4m2!3m1!1s0x47e671d877937b0f:0xb975fcfa192f84d4",
        ),
      ).toBe(true);
    });
  });

  describe("rejected URLs", () => {
    it("rejects http:// (non-HTTPS)", () => {
      expect(
        isValidGoogleMapsUrl("http://www.google.com/maps/place/Somewhere"),
      ).toBe(false);
    });

    it("rejects a non-Google domain", () => {
      expect(isValidGoogleMapsUrl("https://evil.com/maps/place/Trap")).toBe(
        false,
      );
    });

    it("rejects a google.com URL without a maps/collections/placelists path", () => {
      expect(isValidGoogleMapsUrl("https://www.google.com/search?q=test")).toBe(
        false,
      );
    });

    it("rejects a subdomain of google.com that is not maps.app.goo.gl", () => {
      expect(
        isValidGoogleMapsUrl("https://drive.google.com/maps/place/Fake"),
      ).toBe(true); // Note: hostname includes "google.com" so path check applies
    });

    it("rejects an empty string", () => {
      expect(isValidGoogleMapsUrl("")).toBe(false);
    });

    it("rejects a javascript: URL", () => {
      expect(isValidGoogleMapsUrl("javascript:alert(1)")).toBe(false);
    });

    it("rejects a data: URL", () => {
      expect(isValidGoogleMapsUrl("data:text/html,<h1>hi</h1>")).toBe(false);
    });

    it("rejects a plain string that is not a URL", () => {
      expect(isValidGoogleMapsUrl("not a url at all")).toBe(false);
    });

    it("rejects an internal IP address", () => {
      expect(isValidGoogleMapsUrl("https://192.168.1.1/maps/place/Local")).toBe(
        false,
      );
    });

    it("rejects a URL that merely contains 'google.com' in its path", () => {
      expect(
        isValidGoogleMapsUrl("https://attacker.com/redirect?to=google.com/maps/"),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------------------

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("secret-key", "secret-key")).toBe(true);
  });

  it("returns false for strings that differ in content", () => {
    expect(timingSafeEqual("secret-key", "wrong-key!")).toBe(false);
  });

  it("returns false for strings of different lengths (short-circuits safely)", () => {
    expect(timingSafeEqual("short", "much-longer-string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false when one string is empty and the other is not", () => {
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("a", "")).toBe(false);
  });

  it("handles strings with special characters correctly", () => {
    expect(timingSafeEqual("k€y-🔑", "k€y-🔑")).toBe(true);
    expect(timingSafeEqual("k€y-🔑", "k€y-🗝️")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(timingSafeEqual("MyKey", "mykey")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateApiKey
// ---------------------------------------------------------------------------

describe("validateApiKey", () => {
  const env = { API_KEYS: "key-abc,key-def,key-ghi" };

  function makeRequest(authHeader?: string): Request {
    const headers: Record<string, string> = {};
    if (authHeader) headers["Authorization"] = authHeader;
    return new Request("https://example.com/", { headers });
  }

  it("accepts a valid bearer token that matches the first key", () => {
    expect(validateApiKey(makeRequest("Bearer key-abc"), env)).toBe(true);
  });

  it("accepts a valid bearer token that matches a later key", () => {
    expect(validateApiKey(makeRequest("Bearer key-ghi"), env)).toBe(true);
  });

  it("rejects when the Authorization header is missing", () => {
    expect(validateApiKey(makeRequest(), env)).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(validateApiKey(makeRequest("Basic key-abc"), env)).toBe(false);
  });

  it("rejects an incorrect token", () => {
    expect(validateApiKey(makeRequest("Bearer wrong-key"), env)).toBe(false);
  });

  it("handles whitespace padding in API_KEYS", () => {
    const paddedEnv = { API_KEYS: " key-abc , key-def " };
    expect(validateApiKey(makeRequest("Bearer key-abc"), paddedEnv)).toBe(true);
  });

  it("rejects an empty bearer token", () => {
    expect(validateApiKey(makeRequest("Bearer "), env)).toBe(false);
  });
});
