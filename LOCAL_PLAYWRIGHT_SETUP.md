# Local Playwright Server Setup

This guide explains how to use a local Playwright server for development instead of the Cloudflare Browser Rendering API.

## Problem Solved

The previous implementation tried to use filesystem access (`fs.readFileSync`) from within the Wrangler Worker, which doesn't have filesystem access. This caused the error:
```
__dirname is not defined
Cannot connect to local Playwright server at ws://localhost:59012/...
```

## How It Works Now

1. **Playwright Server** (`playwright-server.js`) - Runs as a standalone Node process
   - Starts a Playwright server on a dynamic port
   - Writes the endpoint to `.playwright-endpoint.json` (for reference)
   - **Automatically updates `.env.local` with the endpoint URL** via `update-env.js`

2. **Wrangler Worker** (runs in Cloudflare Workers environment)
   - Reads `PLAYWRIGHT_SERVER_URL` from environment variables (passed via `.env.local`)
   - No filesystem access needed
   - Can now properly connect to the local server

## Setup Steps

### 1. Start the Local Playwright Server

```bash
npm run playwright:server
```

You'll see output like:
```
✅ Playwright server started
📡 WebSocket endpoint: ws://localhost:63885/dafcefb27ee882c157f0edb564345bcf
📝 Endpoint file: /Users/drew/code/browserli/.playwright-endpoint.json

✅ Updated .env.local
📝 PLAYWRIGHT_SERVER_URL=ws://localhost:63885/dafcefb27ee882c157f0edb564345bcf

⚠️  Restart wrangler dev for the change to take effect:
   npm run wrangler:dev
```

### 2. The script automatically updates `.env.local`

No manual action needed! The `update-env.js` helper script is called automatically when the server starts and updates your `.env.local` with the correct endpoint.

### 3. Start Wrangler Dev (in a new terminal)

```bash
npm run wrangler:dev
```

The Worker will now connect to your local Playwright server using the `PLAYWRIGHT_SERVER_URL` from `.env.local`.

## Files Modified

- **`playwright-server.js`** - Now calls `update-env.js` to auto-update `.env.local`
- **`src/index.ts`** - Removed filesystem-based endpoint file reading
- **`update-env.js`** - New helper script that safely updates `.env.local`

## Troubleshooting

### Server starts but wrangler still can't connect

1. Make sure you **restarted `wrangler dev`** after the server started
2. Verify `.env.local` was updated:
   ```bash
   grep PLAYWRIGHT_SERVER_URL .env.local
   ```
3. Check the endpoint is actually running:
   ```bash
   curl -I ws://localhost:XXXX/... 
   ```

### "Cannot connect to local Playwright server" error

1. Make sure the Playwright server is still running:
   ```bash
   npm run playwright:server
   ```
2. Check the endpoint URL in `.env.local` matches what the server printed
3. Restart `wrangler dev` after updating `.env.local`

### update-env.js fails

If the helper script fails to update `.env.local`, you can manually add:
```
PLAYWRIGHT_SERVER_URL=ws://localhost:YOUR_PORT/YOUR_TOKEN
```
to `.env.local` and restart `wrangler dev`.

## Manual Update (if needed)

If you prefer to update `.env.local` manually:

```bash
# Run the server
npm run playwright:server

# In another terminal, manually update .env.local
echo "PLAYWRIGHT_SERVER_URL=ws://localhost:63885/dafcefb27ee882c157f0edb564345bcf" >> .env.local

# Restart wrangler
npm run wrangler:dev
```
