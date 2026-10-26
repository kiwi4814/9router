# 9Router Embeddings Tests

Unit tests for the `/v1/embeddings` endpoint implementation.

## Setup

Install test dependencies from the `tests/` directory:

```bash
cd tests/ && npm install
```

## Running Tests

This fork is maintained as a Qoder CN VPC reverse proxy, so the default run
covers only the Qoder path:

```bash
cd tests/
npm test               # unit/qoder*.test.js (default)
npm run test:qoder-path # Qoder plus the combo / account-fallback guards it relies on
npm run test:all       # every suite in the repository (upstream maintenance)
```

The remaining suites stay on disk for upstream merges; they are not deleted
because the Qoder request path still runs through the shared translator,
chatCore and combo code those suites cover. Run them with `npm run test:all`
when merging upstream, and expect the failures recorded in
`tests/__baseline__/known-fails.txt`.

## Test Files

| File | What it tests |
|------|--------------|
| `unit/embeddingsCore.test.js` | `open-sse/handlers/embeddingsCore.js` — core logic: body builder, URL router, headers, handler flow |
| `unit/embeddings.cloud.test.js` | `cloud/src/handlers/embeddings.js` — cloud worker handler: auth, validation, rate limits, CORS |

## Coverage Summary (59 tests)

### `embeddingsCore.test.js` (36 tests)
- `buildEmbeddingsBody`: single string, array, encoding_format, default float
- `buildEmbeddingsUrl`: openai, openrouter, openai-compatible-*, unsupported providers
- `buildEmbeddingsHeaders`: per-provider header sets, fallback to accessToken
- `handleEmbeddingsCore` input validation: missing, wrong type, null, empty
- `handleEmbeddingsCore` success: response format, CORS, Content-Type, callbacks
- `handleEmbeddingsCore` errors: 400/429/500, network error, invalid JSON
- `handleEmbeddingsCore` token refresh: 401 retry, graceful fallback

### `embeddings.cloud.test.js` (23 tests)
- CORS OPTIONS: 200 response, empty body, correct headers
- Authentication: missing key, bad format, old-format key, wrong key value, valid key
- Body validation: invalid JSON, missing model, missing input, bad model
- Happy path: single string, array, correct delegation, CORS header, machineId override
- Rate limiting: all accounts rate-limited → 503 + Retry-After, no credentials → 400
- Error propagation: non-fallback errors passed through, 429 exhausts accounts
- machineId override: validates key, rejects wrong key
