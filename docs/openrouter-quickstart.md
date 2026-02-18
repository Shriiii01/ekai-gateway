# OpenRouter + Memory — Quick Start

## Build

```sh
docker build --target openrouter-cloudrun -t ekai-openrouter .
```

## Run

```sh
docker run -d --name ekai \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e MEMORY_EMBED_PROVIDER=openrouter \
  -e MEMORY_EXTRACT_PROVIDER=openrouter \
  -p 4010:4010 \
  ekai-openrouter
```

### Environment

| Variable | Required | Default |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | — |
| `MEMORY_EMBED_PROVIDER` | Yes | `gemini` |
| `MEMORY_EXTRACT_PROVIDER` | Yes | `gemini` |
| `OPENROUTER_EMBED_MODEL` | No | `openai/text-embedding-3-small` |
| `OPENROUTER_EXTRACT_MODEL` | No | `openai/gpt-4o-mini` |
| `MEMORY_DB_PATH` | No | `./memory.db` |

## Verify

```sh
# 1. Health
curl localhost:4010/health

# 2. Chat — sends a message and triggers memory ingest
curl localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "user": "clay-test",
    "messages": [{"role": "user", "content": "I believe futarchy is the future of investing. Prediction markets should replace traditional governance for capital allocation decisions."}]
  }'

# 3. Confirm memory was stored
curl "localhost:4010/v1/summary?profile=clay-test"
```

Expected: summary shows counts > 0 in episodic and/or semantic sectors.

## Using OpenAI directly (alternative)

If you have an OpenAI API key and prefer to use it for memory extraction/embedding instead of routing through OpenRouter:

```sh
docker run -d --name ekai \
  -e OPENROUTER_API_KEY=sk-or-...          \
  -e OPENAI_API_KEY=sk-...                 \
  -e MEMORY_EMBED_PROVIDER=openai          \
  -e MEMORY_EXTRACT_PROVIDER=openai        \
  -p 4010:4010 \
  ekai-openrouter
```

This uses OpenAI directly for embeddings (`text-embedding-3-small`) and extraction (`gpt-4o-mini`), while still proxying chat completions through OpenRouter. Override models with `OPENAI_EMBED_MODEL` and `OPENAI_EXTRACT_MODEL`.

## Dashboard

Open http://localhost:4010/memory to browse the Memory Vault UI.
