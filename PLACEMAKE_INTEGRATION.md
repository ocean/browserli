# Placemake Integration Guide

How to integrate Placemake with local Browserli during development.

## Auto-Discovery

When the Playwright server starts, it creates `.playwright-endpoint.json`:

```json
{
  "url": "ws://localhost:56525/692747946b317b9f5579ad0ec31ae830",
  "timestamp": "2026-02-07T10:37:59.123Z",
  "pid": 12345
}
```

Both Browserli and Placemake can read this file to discover the server automatically.

## Placemake Setup

### Option 1: Read from File (Recommended)

In Placemake, create a utility function to read the endpoint:

```elixir
# lib/placemake/browserli_client.ex

defmodule Placemake.BrowserliClient do
  @moduledoc "HTTP client for Browserli service"

  def get_browserli_url do
    case read_playwright_endpoint() do
      {:ok, url} -> url  # Use local Playwright server
      :error -> System.get_env("BROWSERLI_URL", "https://browserli.drewr.dev/data-import")
    end
  end

  defp read_playwright_endpoint do
    endpoint_file = Path.expand("../.browserli/.playwright-endpoint.json", __DIR__)
    
    with {:ok, content} <- File.read(endpoint_file),
         {:ok, data} <- Jason.decode(content),
         url when is_binary(url) <- data["url"] do
      {:ok, url <> "/data-import"}  # Append /data-import endpoint
    else
      _ -> :error
    end
  end

  def import_collection(collection_url, opts \\ []) do
    api_key = System.get_env("BROWSERLI_API_KEY", "dev-key-placemake")
    base_url = get_browserli_url()
    
    Req.post!(base_url, 
      headers: [
        {"authorization", "Bearer #{api_key}"},
        {"content-type", "application/json"}
      ],
      json: %{
        "url" => collection_url,
        "sessionId" => opts[:session_id],
        "pageOffset" => opts[:page_offset] || 0
      }
    )
  end
end
```

### Option 2: Environment Variable

Simpler but requires manual setup:

```elixir
def get_browserli_url do
  System.get_env("BROWSERLI_URL") || "https://browserli.drewr.dev/data-import"
end
```

In `.env.local` during development:

```bash
BROWSERLI_URL=ws://localhost:56525/692747946b317b9f5579ad0ec31ae830/data-import
BROWSERLI_API_KEY=dev-key-placemake
```

## Usage in Placemake

### Import a Collection

```elixir
{:ok, response} = Placemake.BrowserliClient.import_collection(
  "https://www.google.com/collections/s/list/1kYZv2veQuDDbrE7-WeHrOirFMuo/N25VG9BUeoY"
)

# Response includes:
# - sessionId: For pagination
# - places: Array of {name, url, rating, reviewCount}
# - pageInfo: {startIndex, endIndex, totalCount, hasNextPage}
```

### Handle Pagination

```elixir
def import_all_places(collection_url) do
  {:ok, page1} = import_collection(collection_url, page_offset: 0)
  
  places = page1["places"]
  
  # Check if there's a next page
  if page1["pageInfo"]["hasNextPage"] do
    {:ok, page2} = import_collection(
      collection_url,
      session_id: page1["sessionId"],
      page_offset: 200
    )
    places = places ++ page2["places"]
  end
  
  places
end
```

## Queue for Detail Fetching

Once you have the places from Browserli, queue Oban jobs to fetch full details:

```elixir
def queue_detail_extraction(places) do
  Enum.each(places, fn place ->
    %{place_url: place["url"], place_name: place["name"]}
    |> GoogleMapsDetailWorker.new()
    |> Oban.insert()
  end)
end
```

## Debugging

### Check if server is running

```bash
# Read the endpoint file
cat .browserli/.playwright-endpoint.json

# Or check the Playwright server process
lsof -i :3000  # Default Playwright server port
```

### Test a request manually

```bash
# Get the actual endpoint
ENDPOINT=$(jq -r '.url' /Users/drew/code/browserli/.playwright-endpoint.json)

# Make a test request
curl -X POST "$ENDPOINT/data-import" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-key-placemake" \
  -d '{"url": "https://www.google.com/collections/s/list/1kYZv2veQuDDbrE7-WeHrOirFMuo/N25VG9BUeoY"}' | jq .
```

### Check Browserli logs

Browserli runs in Wrangler dev, so check the Wrangler terminal for logs:

```
[DataImport] Loading collection: https://www.google.com/collections/...
[DataImport] Found 200 places on page 1
[DataImport] Pagination info: total=237, hasNext=true, itemsExtracted=200
```

## Troubleshooting

### "Cannot find .playwright-endpoint.json"

The Playwright server isn't running. Start it:

```bash
cd /Users/drew/code/browserli
npm run playwright:server
```

### "Connection refused"

The endpoint in the JSON file might be stale. Restart the server:

1. Stop the running server (Ctrl+C)
2. Start it again: `npm run playwright:server`
3. Read the new endpoint file

### "Authorization failed"

Make sure the API key is correct. In local dev, use:

```bash
BROWSERLI_API_KEY=dev-key-placemake
```

One of these keys must be in Browserli's `API_KEYS` (from `.env.local`):

```bash
API_KEYS=dev-key-local,dev-key-placemake,dev-key-test
```

## Next Steps

1. Implement `Placemake.BrowserliClient` in Placemake
2. Create Oban worker for detail extraction
3. Test end-to-end: collection → extraction → queueing → detail fetching
4. Iterate and optimize
