/**
 * Local Development Utilities
 * 
 * Provides utilities for connecting to a local Playwright server
 * instead of the Cloudflare Browser Rendering API during development.
 */

/**
 * Check if we should use local Playwright server
 */
export function useLocalPlaywright(env: any): boolean {
  return env.USE_LOCAL_PLAYWRIGHT === "1" || env.USE_LOCAL_PLAYWRIGHT === true;
}

/**
 * Get the Playwright connection configuration
 */
export function getPlaywrightConfig(env: any) {
  if (useLocalPlaywright(env)) {
    return {
      type: "local",
      wsEndpoint: env.PLAYWRIGHT_SERVER_URL || "ws://127.0.0.1:3000",
    };
  }
  return {
    type: "cloudflare",
    browser: env.BROWSER,
  };
}

/**
 * Connect to Playwright (local or Cloudflare)
 */
export async function connectPlaywright(env: any, sessionId?: string) {
  const config = getPlaywrightConfig(env);

  if (config.type === "local") {
    // Connect to local Playwright server
    const { chromium } = await import("playwright");
    console.log(`[Local Dev] Connecting to Playwright server at ${config.wsEndpoint}`);

    if (sessionId) {
      // Reuse existing connection (but we can't actually reuse, just log it)
      console.log(`[Local Dev] Note: session reuse not supported with local server (will create new)`);
    }

    try {
      const browser = await chromium.connect(config.wsEndpoint);
      return browser;
    } catch (error) {
      console.error(`[Local Dev] Failed to connect to Playwright server:`, error);
      throw new Error(
        `Cannot connect to local Playwright server at ${config.wsEndpoint}. ` +
        `Make sure to run: node playwright-server.js`
      );
    }
  } else {
    // Use Cloudflare Browser Rendering API
    const { connect, acquire } = await import("@cloudflare/playwright");

    if (sessionId) {
      console.log(`[Cloudflare] Connecting to existing session: ${sessionId}`);
      return await connect(config.browser, sessionId);
    } else {
      console.log("[Cloudflare] Acquiring new browser session");
      const session = await acquire(config.browser);
      console.log(`[Cloudflare] New session ID: ${session.sessionId}`);
      return await connect(config.browser, session.sessionId);
    }
  }
}
