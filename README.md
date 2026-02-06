# 🥦 Browserli

Browser automation for Google Maps data import via Cloudflare Workers and Playwright.

## Features

- 🌐 Pagination through Google Maps collections (robust 200-per-page handling)
- 🤖 Extracts place URLs and basic card data (name, rating, review count)
- ☁️ Runs on Cloudflare Workers with session reuse for large collections
- 🔐 API key authentication
- 📄 Returns paginated results (ideal for batch processing with Oban workers)
- ⚡ Scales on Cloudflare's global network

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account

### Setup

```bash
npm install
```

### Local Development

```bash
npm run dev
```

The worker will be available at `http://localhost:8787`

### Deploy to Cloudflare

```bash
npm run deploy
```

## Configuration

### API Keys (Required)

Browserli requires API key authentication for all endpoints except the root page.

Set API keys as a secret (comma-separated list):

```bash
wrangler secret put API_KEYS "key1,key2,key3"
```

You can have 3-4 keys (one for each environment: local dev, staging, production Placemake app, etc.).

### Domain

Update `wrangler.toml` with your domain:

```toml
[env.production]
routes = [
  { pattern = "browserli.drewr.dev/*", zone_name = "drewr.dev" }
]
```

## API Endpoints

### GET `/` (Root Page)

Public page showing a broccoli emoji. No authentication required.

Unauthenticated requests to other endpoints are redirected here.

### POST `/data-import`

Extracts place URLs from a Google Maps collection page. Handles pagination (200 items per page) and supports session reuse for large collections.

**Headers:**
```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Request body:**
```json
{
  "url": "https://www.google.com/collections/...",
  "sessionId": null,
  "pageOffset": 0
}
```

**Parameters:**
- `url` - Google Maps collection URL (required)
- `sessionId` - Reuse an existing browser session (optional, from previous response)
- `pageOffset` - Resume pagination from a specific offset (optional, for resuming interrupted imports)

**Response:**
```json
{
  "success": true,
  "collectionUrl": "https://www.google.com/collections/...",
  "sessionId": "abc123xyz789...",
  "places": [
    {
      "name": "Stampede Gelato",
      "url": "https://www.google.com/maps/place/Stampede+Gelato/...",
      "rating": 4.7,
      "reviewCount": 342
    },
    ...
  ],
  "pageInfo": {
    "startIndex": 1,
    "endIndex": 200,
    "totalCount": 237,
    "hasNextPage": true
  },
  "durationSeconds": 23.4
}
```

**Pagination flow:**
1. First request: `pageOffset: 0` (get items 1-200)
2. Response includes `sessionId` and `pageInfo.hasNextPage`
3. For next page: `pageOffset: 200, sessionId: "..."`  (get items 201-400)
4. Repeat until `hasNextPage: false`

**Session reuse:**
The `sessionId` keeps the browser session alive on Cloudflare for up to 10 minutes. This is much more efficient than creating a new browser per request for large collections.



## Testing Locally

First, set up API keys for local testing (see DEVELOPMENT.md).

Root page (public):
```bash
curl http://localhost:8787/
```

Data import - first page (requires API key):
```bash
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-test-key" \
  -d '{
    "url": "https://www.google.com/maps/placelists/...",
    "pageOffset": 0
  }' | jq .
```

Data import - next page (using session reuse):
```bash
curl -X POST http://localhost:8787/data-import \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-test-key" \
  -d '{
    "url": "https://www.google.com/maps/placelists/...",
    "sessionId": "SESSION_ID_FROM_PREVIOUS_RESPONSE",
    "pageOffset": 200
  }' | jq .
```

Unauthenticated request (redirects to root):
```bash
curl -X GET http://localhost:8787/data-import
# Returns 302 redirect to /
```

## Architecture

- **wrangler.toml** - Cloudflare Worker configuration
- **src/index.ts** - Main worker handler
  - API key validation and routing
  - Google Maps collection pagination (handles 200 items per page)
  - Place card extraction (name, URL, rating, review count)
  - Session reuse for efficient large collection handling
  - Error recovery and pagination continuation

## Architecture Notes

### Pagination Strategy
- Google Maps shows 200 places per page
- Browserli extracts all visible places and returns them in one batch
- If a collection has 1000+ places, Placemake makes multiple requests with `sessionId` + `pageOffset`
- Session stays alive on Cloudflare for 10 minutes (supports multi-request pagination)

### Data Flow
1. **Placemake** calls Browserli with collection URL
2. **Browserli** loads page, extracts place URLs + basic card data, returns batch
3. **Placemake** queues Oban jobs to fetch full details (address, reviews, images, etc.) for each URL
4. **Placemake** stores enriched places in database
5. **Repeat** if `hasNextPage: true` with next `pageOffset` and `sessionId`

### Session Reuse
- Keep browser open across requests to avoid startup overhead
- Cloudflare maintains session for 10 minutes
- Use `sessionId` from response to continue pagination efficiently

## Next Steps

- [ ] Test with real large Google Maps collections (1000+ items)
- [ ] Implement rate limiting to avoid Google blocking
- [ ] Add retry logic for network failures during pagination
- [ ] Implement progress webhook callbacks to Placemake
- [ ] Extract to separate git repository
