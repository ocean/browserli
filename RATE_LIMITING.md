# Cloudflare Browser Rendering Rate Limiting

## Issue
Browserli hits HTTP 429 (Too Many Requests) when trying to create multiple browser sessions in quick succession.

**Error:** `Unable to create new browser: code: 429: message: Rate limit exceeded`

## Root Cause
This is **Cloudflare Browser Rendering API rate limiting**, not Google Maps or our code.

The `acquire(env.BROWSER)` call fails when Cloudflare's browser pool is overloaded or we've hit the account's rate limits.

## Cloudflare Browser Rendering Limits

Cloudflare has rate limits on the Browser Rendering API:
- **Concurrent sessions**: Limited pool size
- **Request rate**: Throttling per account
- **Session duration**: ~10 minutes of idle time before termination

## Current Behavior

**Symptoms:**
- First request works fine
- Subsequent requests within minutes fail with 429
- Errors appear to be service-level, not request-level

**Possible Causes:**
1. Account-level rate limit on Browser Rendering (e.g., 1-2 concurrent sessions)
2. Cloudflare Workers environment limits
3. High load on Cloudflare's browser service

## Solutions to Investigate

### 1. Check Account Limits (Action: Check Cloudflare Dashboard)
- Navigate to Cloudflare Dashboard → Account → Billing
- Look for Browser Rendering pricing/limits
- Check if we're hitting concurrent session limits

### 2. Implement Exponential Backoff + Retry
```typescript
const acquireWithRetry = async (browser: any, maxRetries = 3) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await acquire(browser);
    } catch (error) {
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Browser acquisition failed after retries');
};
```

### 3. Session Pooling (If we support multiple concurrent imports)
- Maintain a pool of pre-acquired sessions
- Reuse sessions before acquiring new ones
- Keep sessions alive longer

### 4. Queue/Throttle Requests
- Accept requests but queue them
- Process one at a time with delays
- Return immediately with job ID

### 5. Upgrade Plan
- Check if Cloudflare has paid tiers with higher limits
- Browser Rendering might have different limits per plan

## Session Reuse (Currently Implemented)

✅ Already optimized:
- Sessions live ~10 minutes after creation
- Can extract multiple pages with ONE session
- Use `sessionId` from first request for page 2, 3, etc.

**Usage for 237-place collection:**
```bash
# Request 1: Create session, get page 1 (200 places)
curl ... -d '{"url": "..."}' 
# → sessionId: "abc123"

# Request 2: Reuse session, get page 2 (37 places)
curl ... -d '{"url": "...", "sessionId": "abc123", "pageOffset": 200}'
# → Total: 237 places with only 1 rate-limit-inducing session creation
```

This is the best workaround currently.

## Current Status

✅ **Diagnostics added** (deployed):
- Detects rate limit errors and returns 429 status
- Includes `isRateLimit` flag in response
- Sets `Retry-After` header

✅ **Session reuse working**:
- Once a session is created, can paginate indefinitely

❌ **Blocker**: Can't create multiple fresh sessions quickly

## Recommendations

1. **For users**: 
   - Always reuse sessionId for multi-page imports
   - Space out requests if creating multiple new sessions
   - Wait 2+ minutes between new session creations

2. **For Browserli**:
   - Add queue system for multiple concurrent imports
   - Or add retry logic with exponential backoff
   - Document session reuse as the recommended pattern

3. **Check with Cloudflare**:
   - Confirm actual limits for our account
   - Ask about increasing limits
   - Check if there's a way to dedicate browser instances
