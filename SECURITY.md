# Security & API Keys

## Authentication

Browserli requires API key authentication for all endpoints except the public root page.

### API Key Format

- **Header**: `Authorization: Bearer YOUR_API_KEY`
- **Storage**: Cloudflare Worker Secrets (not logged or exposed)
- **Multiple Keys**: Supported via comma-separated list in `API_KEYS` secret

### Behavior

| Request Type | Authentication | Action |
|---|---|---|
| `GET /` | None | Return root page (broccoli emoji) |
| `POST /data-import` | Required | Process data-import request if valid |
| `GET /data-import` | Invalid/Missing | Redirect to `/` (302) |
| `POST /data-import` | Invalid/Missing | Return 401 Unauthorized JSON |
| Any other path | Invalid/Missing | Same as above |

### Setting Up API Keys

For production (Cloudflare):
```bash
wrangler secret put API_KEYS --env production
# When prompted, enter comma-separated keys:
# production-key-1,production-key-2
```

For local development:
```bash
wrangler secret put API_KEYS
# When prompted, enter:
# dev-key-1,dev-key-2,staging-key
```

## Key Rotation

To rotate keys without downtime:

1. Add new key to comma-separated list:
   ```bash
   wrangler secret put API_KEYS "old-key,new-key-1,new-key-2"
   ```

2. Update all clients to use a new key

3. Remove old key from list:
   ```bash
   wrangler secret put API_KEYS "new-key-1,new-key-2"
   ```

## Security Considerations

✅ **What we do:**
- Require API key for all sensitive endpoints
- Keys are stored as Cloudflare Secrets (encrypted at rest)
- Support multiple keys for rotation/environment separation
- Redirect unauthenticated browsers to root page (prevents information leakage)

⚠️ **What you should do:**
- Keep API keys private (treat like passwords)
- Use different keys for different environments (dev, staging, prod)
- Rotate keys periodically
- Monitor API usage/rate limits in Cloudflare logs
- Use HTTPS only (enforced by Cloudflare)

## Deployment

When deploying to production:

1. Ensure `wrangler.toml` targets correct environment:
   ```bash
   wrangler deploy --env production
   ```

2. Set API keys as secrets:
   ```bash
   wrangler secret put API_KEYS --env production
   ```

3. Verify deployment:
   ```bash
   curl https://browserli.drewr.dev/
   # Should return broccoli emoji page
   
   curl https://browserli.drewr.dev/data-import \
     -H "Authorization: Bearer invalid-key"
   # Should return 401 Unauthorized
   ```

## Rate Limiting

Currently, Browserli has no built-in rate limiting. Consider adding:

- Cloudflare Workers Rate Limiting API
- Per-key rate limits in a KV store
- Request queuing via Durable Objects

This can be added in a future release if needed.
