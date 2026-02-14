# Memory Service (Ekai)

Neuroscience-inspired, sectorized memory kernel. Runs as a standalone service (default port 4005) and is currently opt-in.

## Quickstart (standalone)

```bash
npm install -w memory
npm run build -w memory
npm start -w memory
```

Env (root `.env` or `memory/.env`):

- `GOOGLE_API_KEY` (required for Gemini extract/embeds)
- Optional: `GEMINI_EXTRACT_MODEL` (default `gemini-2.5-flash`)
- Optional: `GEMINI_EMBED_MODEL` (default `gemini-embedding-001`)
- Optional: `MEMORY_PORT` (default `4005`)
- Optional: `MEMORY_DB_PATH` (default `./memory.db`)
- Optional: `MEMORY_CORS_ORIGIN`

## API (v0)

- `POST /v1/ingest` — ingest an experience
  Body:
  ```json
  {
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "reasoning": "optional",
  "feedback": {
    "type": "success|failure",
    "value": 0
  },
  "metadata": {}
  }
  ```
  Requires at least one user message. `reasoning`, `feedback`, and `metadata` are optional and currently not used in extraction/scoring (feedback is not yet applied; retrieval_count drives expected_value).

- `POST /v1/ingest/documents` — ingest markdown files from a directory
  Body:
  ```json
  { "path": "/path/to/markdown/folder", "profile": "project-x" }
  ```
  Reads all `.md` files recursively, chunks by markdown headings, extracts memories via LLM, and stores with deduplication + source attribution. Re-ingesting the same folder is safe — duplicates are skipped.
  Response:
  ```json
  { "ingested": 5, "chunks": 18, "stored": 31, "skipped": 4, "errors": [], "profile": "project-x" }
  ```

- `POST /v1/search` — body `{ "query": "..." }` → returns `{ workingMemory, perSector }` with PBWM gating.

- `GET /v1/summary` — per-sector counts + recent items (includes procedural details).

- `DELETE /v1/memory/:id` — delete one; `DELETE /v1/memory` — delete all.

- `GET /health`

## Data model (SQLite)

- `memory` table for episodic:
  `id, sector, content, embedding, created_at, last_accessed, event_start, event_end, source`.
- `procedural_memory` table for structured procedures:
  `trigger, goal, context, result, steps[], embedding, timestamps, source`.
- `retrieval_count` tracks how often a memory enters working memory; used in PBWM expected_value.
- `semantic_memory` (graph-lite facts): `subject, predicate, object, valid_from, valid_to, strength, embedding, metadata, source`.
- `source` column (`TEXT DEFAULT NULL`) stores the relative file path for document-ingested memories (e.g., `notes/architecture.md`). NULL for chat-ingested memories.

## Semantic Consolidation

When ingesting semantic facts, the system applies consolidation logic using **semantic similarity** for predicate matching:

1. **Find existing facts**: Query all active facts for the same subject
2. **Semantic predicate matching**: Use embeddings to find predicates with ≥0.9 cosine similarity
   - "is co-founder of" ≈ "cofounded" ≈ "founded" → treated as same slot
3. **Consolidation action**:
   - **Merge**: Same object exists → strengthen it (increment `strength`)
   - **Supersede**: Different object for similar predicate → close old fact (`valid_to = now`), insert new
   - **Insert**: No matching predicate → insert new with `strength = 1.0`

This approach:
- Handles natural language variation in predicates (synonyms, paraphrases)
- Preserves history while avoiding duplicate facts
- Superseded facts remain queryable for temporal reasoning

## Retrieval

- Query is embedded per sector.
- Candidates with cosine `< 0.2` are dropped.
- PBWM-inspired gate (prefrontal–basal ganglia model) scores the rest:

  ```
  x = 1.0 * relevance + 0.4 * expected_value + 0.05 * control - 0.02 * noise
  gate_score = sigmoid(x)
  ```
- We use retrieval_count (log-normalized) for `expected_value` and keep `control = 0.3` for now; small Gaussian noise is applied.
- Candidates with `gate_score > 0.5` are kept, then top-k per sector are merged and capped to a working-memory size of 8.

## Architecture (v0)

```mermaid
graph TB
  classDef inputStyle fill:#eceff1,stroke:#546e7a,stroke-width:2px,color:#37474f
  classDef processStyle fill:#e3f2fd,stroke:#1976d2,stroke-width:2px,color:#0d47a1
  classDef sectorStyle fill:#fff3e0,stroke:#f57c00,stroke-width:2px,color:#e65100
  classDef storageStyle fill:#fce4ec,stroke:#c2185b,stroke-width:2px,color:#880e4f
  classDef engineStyle fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#4a148c
  classDef outputStyle fill:#e8f5e9,stroke:#388e3c,stroke-width:2px,color:#1b5e20

  EXP["Experience Ingest<br>messages + reasoning/feedback"]:::inputStyle
  EXTRACT["Extractor (Gemini)<br>episodic / semantic / procedural"]:::processStyle

  EPISODIC["Episodic"]:::sectorStyle
  SEMANTIC["Semantic"]:::sectorStyle
  PROCEDURAL["Procedural<br>structured: trigger / goal / steps"]:::sectorStyle

  EMBED["Embedder (Gemini)<br>text-embedding-004"]:::processStyle

  STORE["(SQLite)<br>memory table (event_start/end)<br>procedural_memory table"]:::storageStyle
  FACTGRAPH["Semantic Facts<br>subject/predicate/object graph"]:::storageStyle
  STEPGRAPH["Action DAG<br>ordered steps"]:::storageStyle

  QUERY["Search Query"]:::inputStyle
  QEMBED["Query Embeds<br>per sector"]:::processStyle
  CANDIDATES["Candidates<br>(cosine ≥ 0.2)"]:::engineStyle
  PBWM["PBWM Gate<br>sigmoid(1.0*rel + 0.4*exp + 0.05*ctrl - 0.02*noise)"]:::engineStyle
  WM["Working Memory<br>top-k per sector → cap 8"]:::engineStyle

  OUTPUT["Recall Response<br>(workingMemory + perSector)"]:::outputStyle
  UI["Dashboard Memory Vault<br>summary + recent + delete"]:::outputStyle

  EXP --> EXTRACT
  EXTRACT --> EPISODIC
  EXTRACT --> SEMANTIC
  EXTRACT --> PROCEDURAL

  EPISODIC --> EMBED
  SEMANTIC --> FACTGRAPH
  FACTGRAPH --> EMBED
  PROCEDURAL --> STEPGRAPH
  STEPGRAPH --> EMBED

  EMBED --> STORE

  QUERY --> QEMBED --> CANDIDATES --> PBWM --> WM --> OUTPUT
  STORE --> CANDIDATES

  OUTPUT --> UI
```

## Notes / Limitations

- Only Gemini provider is wired (provider abstraction is pending). OpenAI would need wiring.
