# DIZA Prompt Director

Standalone, web-first DIZA Prompt Director for Cloudflare Workers.

## Architecture

Reference image
→ Dots3 Vision (OpenRouter)
→ factual `SCENE_FACTS`
+ user request
→ L3-70B Euryale v2.1 (Pollinations)
→ structured director package
→ immutable `final_prompt`
→ SHA-256 integrity hash

No OpenAI/GPT/Luna/Qwen model is used in this prompt-generation path.

## Locked behavior

- Vision only observes the current image.
- Director owns the final prompt.
- The orchestration layer does not rewrite `final_prompt`.
- No silent model fallback.
- A provider failure remains visible as a provider error.
- Venice Uncensored 24B remains the preferred future Director target, but the old free OpenRouter slug is not used while unavailable.

## Current model IDs

Vision:
`dots-studio/dots-3-note-preview:free`

Temporary Director:
`community/AkshayCoder48/L3-70B-Euryale-v2.1`

## Cloudflare deployment

1. Install dependencies:

   `npm install`

2. Login to Cloudflare:

   `npx wrangler login`

3. Add server-side secrets:

   `npx wrangler secret put OPENROUTER_API_KEY`

   `npx wrangler secret put POLLINATIONS_API_KEY`

4. Deploy:

   `npm run deploy`

Cloudflare secrets are never exposed to browser JavaScript.

## Development

Create `.dev.vars` locally:

```
OPENROUTER_API_KEY=...
POLLINATIONS_API_KEY=...
```

Then run:

`npm run dev`

## API

### `GET /api/health`

Returns service/model status metadata.

### `POST /api/vision`

Multipart form field:
- `image`

Returns:
- `report`
- `engine`

### `POST /api/director`

JSON:
```json
{
  "sceneFacts": "...",
  "userRequest": "..."
}
```

Returns the complete director package plus:
- `engine`
- `sha256`

The SHA is computed from the exact `final_prompt` string returned by the Director.
