// Type declarations for Cloudflare Workers bindings used in tests.
// Augments the global `Cloudflare.Env` namespace so that `env` imported from
// "cloudflare:test" is correctly typed throughout the test suite.

// oxlint-disable-next-line typescript-eslint/triple-slash-reference -- required by @cloudflare/vitest-pool-workers
/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

declare namespace Cloudflare {
  interface Env {
    BROWSER_SESSIONS: KVNamespace;
    BROWSER: unknown;
    API_KEYS: string;
    USE_LOCAL_PLAYWRIGHT?: string;
    PLAYWRIGHT_SERVER_URL?: string;
    API_RATE_LIMITER?: {
      limit: (opts: { key: string }) => Promise<{ success: boolean }>;
    };
    BROWSER_MAX_SESSIONS?: string;
    BROWSER_KEEP_ALIVE_MS?: string;
  }
}
