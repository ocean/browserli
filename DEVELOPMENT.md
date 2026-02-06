# Development Guide

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start local development server:
   ```bash
   npm run dev
   ```

   The worker will be available at `http://localhost:8787`

## Testing Endpoints

### Root Page (Public)

```bash
curl http://localhost:8787/
```

Response: HTML page with animated broccoli emoji 🥦

### Data Import Endpoint (Requires API Key)

```bash
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-1" \
  -d '{
    "url": "https://www.google.com/collections/...",
    "maxPlaces": 5
  }'
```

Response: JSON with imported places (see README.md for full response format)

### Unauthenticated Request

```bash
curl -X GET http://localhost:8787/data-import -v
```

Response: 302 redirect to `/` (root page)

## Adding API Keys (Secrets)

API keys are mandatory. For local development, set them as a secret:

```bash
wrangler secret put API_KEYS
# Paste comma-separated keys when prompted, e.g.:
# dev-key-1,dev-key-2,staging-key
```

Alternatively, edit `.env.local` (if you prefer):
```
API_KEYS=dev-key-1,dev-key-2,staging-key
```

Then test with one of the keys:
```bash
curl http://localhost:8787/  # Root page (public, no key needed)

curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-1" \
  -d '{
    "url": "https://www.google.com/collections/...",
    "maxPlaces": 5
  }'

# Unauthenticated request gets redirected:
curl -X GET http://localhost:8787/data-import
# Response: 302 redirect to /
```

## Debugging

The worker logs to stdout. When running `npm run dev`, you'll see logs like:

```
[DataImport] Loading collection: https://www.google.com/collections/...
[DataImport] Found 42 places in collection
[DataImport] Extracted 10/42 places
...
[DataImport] Completed in 23.45s
```

## Playwright Tips

The `@cloudflare/playwright` API is similar to standard Playwright:

- `browser.newPage()` - Create a new page
- `page.goto(url)` - Navigate to a URL
- `page.locator(selector)` - Find elements
- `page.textContent()` - Extract text
- `page.getAttribute(attr)` - Get HTML attribute
- `page.url()` - Get current URL

See [Cloudflare Playwright docs](https://developers.cloudflare.com/browser-rendering/playwright/) for more.

## TypeScript

The project uses TypeScript. Run type checking:

```bash
npm run type-check
```

## Linting

```bash
npm run lint
```

## Deploying

When ready to deploy to Cloudflare:

1. Ensure you're logged in:
   ```bash
   wrangler login
   ```

2. Deploy:
   ```bash
   npm run deploy
   ```

3. Set API key as secret:
   ```bash
   wrangler secret put API_KEY --env production
   ```

## Project Structure

```
browserli/
├── src/
│   └── index.ts          # Main worker handler
├── wrangler.toml         # Cloudflare Worker config
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
└── README.md             # User documentation
```

## Next Steps

1. Test Google Maps data import with a real collection URL
2. Refine place detail extraction selectors
3. Add request rate limiting
4. Implement URL caching
5. Add more comprehensive error handling
