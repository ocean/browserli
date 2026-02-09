# Local Playwright Server Setup

This guide explains how to use a local Playwright server for development instead of the Cloudflare Browser Rendering API.

## Architecture

The browserli Worker environment cannot import Node.js modules (they get bundled and fail with `__dirname` errors). Instead, we use an HTTP API proxy approach:

```
┌─────────────────────┐
│  Wrangler Worker    │
│  (Browser context)  │
└──────────┬──────────┘
           │ fetch()
           ▼
┌─────────────────────────────────────────┐
│  Local Playwright Server (Node.js)      │
│  ┌──────────────────┐ ┌──────────────┐  │
│  │ Port 3000: CDP   │ │ Port 3001:   │  │
│  │ WebSocket        │ │ HTTP API     │  │
│  │ (Playwright      │ │ (for Worker) │  │
│  │  native)         │ │              │  │
│  └──────────────────┘ └──────────────┘  │
└─────────────────────────────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Chromium/Browser│
    └─────────────────┘
```

## Setup

### 1. Start the Playwright Server

```bash
npm run playwright:server
```

Output:
```
✅ Playwright server started
📡 CDP WebSocket endpoint: ws://localhost:3000/84dfdcdb437ce2770a4a07e72e2a3cf8
📡 HTTP API endpoint: http://localhost:3001

⚠️  Update .env.local with:
PLAYWRIGHT_SERVER_URL=http://localhost:3001

Then restart wrangler dev:
npm run wrangler:dev
```

### 2. Update `.env.local`

Copy the HTTP API endpoint into `.env.local`:
```
PLAYWRIGHT_SERVER_URL=http://localhost:3001
```

### 3. Start Wrangler Dev (in another terminal)

```bash
npm run wrangler:dev
```

The Worker will now use the HTTP API proxy to control Playwright.

### 4. Combined Development (Optional)

Use the combined script to start both at once:
```bash
npm run dev:full
```

This starts:
- Playwright server (port 3000 CDP, 3001 HTTP API)
- Wrangler dev (port 8787)

## How It Works

1. **Playwright Server** (`playwright-server.js`)
   - Starts a CDP server on port 3000
   - Starts an HTTP API proxy on port 3001
   - Provides REST endpoints for Worker to call

2. **Worker** (`src/index.ts`)
   - Uses `fetch()` to call HTTP endpoints (no Node.js imports!)
   - Calls `http://localhost:3001/api/page/goto`
   - Calls `http://localhost:3001/api/page/evaluate`
   - Calls `http://localhost:3001/api/page/close`

3. **HTTP API Server** (`playwright-server.js`)
   - Manages browser sessions
   - Executes Playwright operations
   - Returns results via JSON

## API Endpoints

- `POST /api/page/goto` - Navigate to a URL
  ```json
  { "url": "...", "options": {}, "sessionId": "..." }
  ```

- `POST /api/page/evaluate` - Run JavaScript in the page
  ```json
  { "script": "function() { ... }", "sessionId": "..." }
  ```

- `POST /api/page/close` - Close the page
  ```json
  { "sessionId": "..." }
  ```

## Troubleshooting

### Port 3000 or 3001 already in use

```bash
# Find what's using the port
lsof -i :3000
lsof -i :3001

# Kill the process
kill -9 <PID>
```

### Worker can't connect to HTTP API

1. Verify the Playwright server is running:
   ```bash
   curl http://localhost:3001/
   ```

2. Check `.env.local` has the correct URL:
   ```bash
   grep PLAYWRIGHT_SERVER_URL .env.local
   ```

3. Restart `wrangler dev` after updating `.env.local`

### Places not being extracted

1. Check the console logs for errors
2. Verify the page selector selectors haven't changed:
   ```bash
   # Look for this in the logs:
   [HTTP API] evaluate returned 200 items
   ```
3. Test the extraction directly on the Google Maps collection page
