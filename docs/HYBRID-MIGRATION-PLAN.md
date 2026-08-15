# Bridge — Hybrid Architecture Migration Plan

**Status:** Approved, not started
**Decision date:** 2026-08-14
**Supersedes:** all-in-browser embedding/storage (transformers.js + Dexie)

---

## 1. Decision

Bridge moves from a fully in-browser extension to a **hybrid**: a thin TypeScript extension for anything that touches the DOM, plus a local Python daemon that owns storage, embedding, and retrieval.

**Why:** native ONNX embedding instead of WASM, real SQL instead of IndexedDB inspection, no 30 MB model wedged into browser storage, and a debugging surface that isn't the service-worker console.

**What it costs:** install becomes "Add to Chrome + run the daemon." This is a real regression in distribution and is accepted knowingly. Mitigation is in Phase 4.

**What is NOT changing:** the product. Same 5-stage pipeline, same trigger semantics, same injection UX, same local-only privacy promise. Nothing leaves `127.0.0.1`.

---

## 2. The split

Manifest V3 has no Python runtime. The boundary is not negotiable — it's drawn at "does this touch the page?"

### Stays TypeScript (extension)

| Module | Reason |
|---|---|
| `src/adapters/` | DOM selectors, message parsing, project scraping |
| `src/content/` | Content-script wiring, MutationObservers, route changes |
| `src/triggers/boundary.ts` | Runs on every debounced keystroke — a localhost round trip per keystroke is latency we don't need to spend |
| `src/ui/` | Shadow DOM indicator, injection badge |
| `src/background/` | Tab coordination, daemon health check |

### Moves to Python (daemon)

| Was | Becomes |
|---|---|
| `src/storage/` (Dexie) | SQLite + `sqlite-vec` |
| `src/embeddings/` (transformers.js) | `sentence-transformers`, `BAAI/bge-small-en-v1.5` |
| `src/workers/` (Web Worker) | asyncio task / thread pool |
| `src/retrieval/search.ts` | numpy cosine or `vec0` virtual table |
| `src/import/` (hidden-tab backfill) | Playwright with a persistent profile |

### Deleted outright

`@xenova/transformers`, `dexie`, the embedding Web Worker, the IndexedDB schema and migrations. Roughly the entire reason the bundle is large.

---

## 3. Target repo layout

```
bridge/
├── extension/            # existing WXT project, moved down one level
│   ├── src/
│   │   ├── adapters/
│   │   ├── content/
│   │   ├── triggers/
│   │   ├── ui/
│   │   ├── background/
│   │   └── client/       # NEW — typed HTTP client for the daemon
│   └── package.json
├── daemon/               # NEW
│   ├── bridge/
│   │   ├── __init__.py
│   │   ├── main.py       # FastAPI app, binds 127.0.0.1 only
│   │   ├── db.py         # SQLite schema + migrations
│   │   ├── embed.py      # model load, encode, batching
│   │   ├── retrieval.py  # threshold / top-k / dedupe / token budget
│   │   ├── importer.py   # Playwright backfill
│   │   └── config.py
│   ├── tests/
│   └── pyproject.toml
├── docs/
│   └── HYBRID-MIGRATION-PLAN.md
└── README.md
```

---

## 4. API contract

Base URL `http://127.0.0.1:8787`. JSON in, JSON out. This contract is the thing to freeze first — both sides can then be built independently.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `{status, model_loaded, version}`. Extension polls on init; if it fails, Bridge degrades to capture-only and shows a "daemon offline" state. |
| `POST` | `/conversations` | Upsert a captured conversation + its messages. Chunking and embedding happen server-side, async. Returns immediately with `{id, queued: true}`. |
| `POST` | `/search` | `{query, sources: [...], top_k, threshold}` → `{results: [{text, conversation_id, title, source, score, tokens}]}`. Filtering, dedupe, and token budget applied server-side. |
| `GET` | `/conversations` | List/paginate for the dashboard. |
| `DELETE` | `/conversations/{id}` | Delete + cascade chunks. |
| `GET` | `/stats` | Counts for the dashboard and for verifying backfill progress. |

**Retrieval params stay as-is:** threshold `0.6`, top-k `3`, token budget `2000`. Ported values, not re-tuned. Re-tuning is a separate change with its own before/after.

---

## 5. Data model

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,      -- platform:native_id
  platform    TEXT NOT NULL,         -- 'claude' | 'chatgpt' | ...
  project     TEXT,                  -- NULL for non-project chats
  title       TEXT,
  url         TEXT,
  captured_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_conv_platform ON conversations(platform);
CREATE INDEX idx_conv_project  ON conversations(project);

CREATE TABLE chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  text            TEXT NOT NULL,
  tokens          INTEGER NOT NULL,
  embedded_at     INTEGER               -- NULL = not yet embedded
);
CREATE INDEX idx_chunks_conv     ON chunks(conversation_id);
CREATE INDEX idx_chunks_pending  ON chunks(embedded_at) WHERE embedded_at IS NULL;

-- sqlite-vec
CREATE VIRTUAL TABLE chunk_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);
```

`embedded_at IS NULL` is the work queue. It survives restarts, which the current fire-and-forget path does not — a crash mid-embed currently loses those chunks silently.

**Model is locked to `bge-small-en-v1.5`, 384-dim.** Query-time and index-time must match. Changing it means reindexing everything; treat the model name as a schema version.

---

## 6. Phases

Each phase ends in something runnable. No phase leaves the tree broken.

### Phase 0 — Close out the stage-3 bug first
Before any restructuring: reload the extension, capture the console output from the debug-logging pass, and confirm the project scraper now populates `bridge:claude:projects` and the trigger fires. A migration on top of an unverified pipeline means every future bug has two possible causes.

**Done when:** the "📚 N chats found" indicator appears on a cross-project reference, once, in the current architecture.

### Phase 1 — Daemon skeleton
`pyproject.toml`, FastAPI app, SQLite schema, `/health` and `/stats`. No embedding yet. Bind `127.0.0.1`, CORS allowlist for the extension origin only.

**Done when:** `curl 127.0.0.1:8787/health` returns 200 and the DB file is created on first run.

### Phase 2 — Embedding + retrieval in Python
`embed.py` loads the model once at startup. Background worker drains `embedded_at IS NULL`. `/search` implements filter → cosine → threshold → top-k → dedupe → token budget.

**Done when:** a seeded set of ~20 conversations returns the same top-3 for a fixed test query as the current TS implementation. Capture that comparison in `daemon/tests/` — it's the regression net for everything after.

### Phase 3 — Extension cutover
Add `src/client/`, swap `storage/` and `retrieval/` call sites to HTTP, delete `@xenova/transformers` and `dexie`, add the offline-degraded state. One-time IndexedDB → SQLite export path so existing captures aren't lost.

**Done when:** the full trigger → retrieve → inject loop works end to end with the daemon running, and the extension bundle drops by roughly the size of the ONNX runtime.

### Phase 4 — Packaging
The distribution problem. Options in preference order: single-file binary via PyInstaller with a launch-at-login helper; `pipx install bridge-daemon`; Docker (rejected — too heavy for the target user). Model download on first run with a progress state surfaced in the extension.

**Done when:** a non-technical person can go from zero to working in under three minutes on a clean machine.

### Phase 5 — Playwright backfill
Port the hidden-tab importer. Python-side is strictly better here: no tab-count limits, no heartbeat lock, resumable from the DB.

---

## 7. Security requirements

Non-negotiable, and easy to get wrong:

- Bind `127.0.0.1`, **never** `0.0.0.0`. Binding wide publishes the user's entire AI history to their local network.
- CORS: allowlist the extension origin explicitly. No `*`.
- Extension needs `host_permissions: ["http://127.0.0.1:8787/*"]`.
- No telemetry, no outbound calls except the one-time model download from HuggingFace.
- DB file at the OS-appropriate app-data path with user-only permissions (`0600`).
- Reject requests with an `Origin` header that isn't the allowlisted extension.

---

## 8. Open items

- Extension ID is needed to pin the CORS allowlist. Unstable in dev — use a keyed manifest so it's fixed across reloads.
- Daemon-offline UX: does Bridge queue captures locally and flush on reconnect, or drop them? Queuing means keeping a small IndexedDB buffer, which partly undoes the deletion. Leaning: drop, and surface it clearly.
- Whether the dashboard stays an extension page or becomes a page served by the daemon.
- Port collision handling if 8787 is taken.

---

## 9. Explicitly out of scope

Cloud sync, accounts, payments, the MCP server, non-Claude adapters, re-tuning retrieval parameters, and any change to trigger semantics. This migration changes *where the code runs*, nothing else. Anything that changes what the product does is a separate decision.
