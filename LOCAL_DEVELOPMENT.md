# Local Development Setup

Avoid Cloudflare Browser Rendering API rate limits by running everything locally during development.

## Quick Start (All-in-One)

```bash
# Terminal 1: Start both Playwright server + Wrangler worker
npm run dev:full

# This creates: .playwright-endpoint.json (auto-discovery file)
# Both Browserli and Placemake will read this to find the server

# Terminal 2 (in placemake): Start Phoenix app
cd ../placemake
mix phx.server

# Terminal 3: Test the full flow
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-local" \
  -d '{
    "url": "https://www.google.com/collections/s/list/1kYZv2veQuDDbrE7-WeHrOirFMuo/N25VG9BUeoY"
  }'
```

## Detailed Setup

### 1. Configure Local Environment

Copy the example environment file:

```bash
cp .env.local.example .env.local
```

The `.env.local` file contains:
- `PLAYWRIGHT_SERVER_URL`: Local Playwright server address (optional if using auto-discovery)
- `API_KEYS`: Test API keys for local development
- `USE_LOCAL_PLAYWRIGHT`: Flag to enable local mode

**Auto-Discovery:** When the Playwright server starts, it creates `.playwright-endpoint.json` with the actual WebSocket endpoint. Both Browserli and Placemake read this file automatically, so you don't need to manually update `.env.local`.

### 2. Start Playwright Server (Terminal 1)

```bash
npm run playwright:server

# Output should show:
# ✅ Playwright server started
# 📡 WebSocket endpoint: ws://127.0.0.1:3000
```

The Playwright server needs to be running before the Worker can use it.

### 3. Start Wrangler Dev (Terminal 2)

```bash
npm run dev

# Should see:
# ⛅️ wrangler 4.63.0
# ▲ [dev] Worker listening on http://localhost:8787
```

Wrangler will automatically pick up `.env.local` variables.

### 4. Start Placemake (Terminal 3)

```bash
cd ../placemake
mix phx.server
```

### 5. Test the Integration

In Placemake, the google maps importer should call the local browserli:

```elixir
# In lib/placemake/import.ex, set the base URL to local:
url = System.get_env("BROWSERLI_URL", "http://localhost:8787/data-import")
```

Then test with:

```bash
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-local" \
  -d '{
    "url": "https://www.google.com/collections/s/list/1kYZv2veQuDDbrE7-WeHrOirFMuo/N25VG9BUeoY"
  }' | jq .
```

## How It Works

### Local Mode (Development)

```
Placemake → Wrangler Dev (8787) → Local Playwright Server (3000)
                                  ↓
                            Google Maps Collections
```

- **No rate limiting** from Cloudflare
- **Direct Playwright** control for debugging
- **Fast iteration** on extraction code

### Cloud Mode (Production)

```
Placemake → Cloudflare Worker → Cloudflare Browser Rendering API
                                 ↓
                           Google Maps Collections
```

- Deployed to `browserli.drewr.dev`
- Uses Cloudflare's managed browser pool
- Session reuse for pagination

## Switching Modes

### Use Local Playwright (Development)

Set in `.env.local`:

```bash
USE_LOCAL_PLAYWRIGHT=1
PLAYWRIGHT_SERVER_URL=ws://127.0.0.1:3000
```

### Use Cloudflare (Production/Testing)

When deployed to Cloudflare, the Worker automatically uses the Cloudflare Browser Rendering API.

Locally, to test Cloudflare mode (requires valid Cloudflare secrets):

```bash
# Don't set USE_LOCAL_PLAYWRIGHT or set to 0
USE_LOCAL_PLAYWRIGHT=0
```

## Troubleshooting

### "Cannot connect to local Playwright server"

The Playwright server isn't running. Start it:

```bash
npm run playwright:server
```

### "Authorization: invalid or missing API key"

Check your curl command includes:

```bash
-H "Authorization: Bearer dev-key-local"
```

One of the keys in `.env.local` `API_KEYS` must match.

### "Port 8787 already in use"

Another process is using the port. Either:

1. Kill the existing process: `lsof -ti:8787 | xargs kill -9`
2. Use a different port: `PORT=8788 npm run dev`

### "Port 3000 already in use"

Change the Playwright server port:

```bash
PLAYWRIGHT_SERVER_PORT=3001 npm run playwright:server
```

Then update `.env.local`:

```bash
PLAYWRIGHT_SERVER_URL=ws://127.0.0.1:3001
```

## Performance Notes

Local Playwright can be slower than Cloudflare's optimised service, but good enough for development:

- Initial page load: ~3-5 seconds
- Pagination click: ~2-4 seconds
- Total for 237 places (2 pages): ~20-30 seconds

## Debugging

Enable verbose logging by modifying the Worker code to add console.log statements. Logs appear in the Wrangler dev terminal.

### Debug a single extraction:

```bash
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-local" \
  -d '{
    "url": "https://www.google.com/collections/s/list/1kYZv2veQuDDbrE7-WeHrOirFMuo/N25VG9BUeoY",
    "debug": true
  }' | jq .debug.domStructure
```

## Next Steps

Once local iteration is working:

1. Refine the extraction selectors for edge cases
2. Test pagination with different collection sizes
3. Implement Placemake's queueing logic
4. Test end-to-end: collection → extraction → queueing → detail fetching
5. Deploy to production when satisfied
