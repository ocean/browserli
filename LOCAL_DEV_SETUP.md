# Local Development Setup - Quick Reference

## Files Created/Modified

### New Files
- `playwright-server.js` - Starts local Playwright server
- `.env.local` - Local environment variables (added to .gitignore)
- `.env.local.example` - Template for .env.local
- `src/local-dev.ts` - Utilities for local/cloud switching
- `LOCAL_DEVELOPMENT.md` - Full development guide

### Modified Files
- `package.json` - Added dev scripts

## Key Environment Variables

```bash
USE_LOCAL_PLAYWRIGHT=1                        # Use local instead of Cloudflare
PLAYWRIGHT_SERVER_URL=ws://127.0.0.1:3000     # Local Playwright server address
API_KEYS=dev-key-local,dev-key-placemake      # Test API keys
```

## Quick Commands

```bash
# Start Playwright server (Terminal 1)
npm run playwright:server

# Start Wrangler dev (Terminal 2)
npm run dev

# Or start both at once (Terminal 1)
npm run dev:full

# Test from Placemake (Terminal 3)
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-local" \
  -d '{"url": "https://www.google.com/collections/..."}'
```

## Benefits

✅ **No Cloudflare rate limits** - Avoid the 429 errors
✅ **Full control** - Can debug Playwright directly
✅ **Fast iteration** - Reload Worker code instantly
✅ **Offline friendly** - Doesn't require Cloudflare services
✅ **Cost free** - No API calls to production services

## Next: Integrate with Placemake

You'll need to update Placemake's importer to:

1. Point to `http://localhost:8787/data-import` during local dev
2. Use `dev-key-local` as the API key in tests
3. Handle both page 1 and page 2 requests with session reuse

See `LOCAL_DEVELOPMENT.md` for full details.
