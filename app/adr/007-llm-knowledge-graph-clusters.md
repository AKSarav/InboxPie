# ADR 007: LLM-Powered Knowledge Graph for Clusters View

**Status:** PROPOSED  
**Date:** 2026-07-17

---

## Context

The current Clusters / Knowledge Map view builds groups via K-means on 768-dim embedding vectors, then labels them with bigram/trigram frequency analysis of email subjects. This is a statistical approximation — the graph shows "similarity blobs," not real semantic relationships. Entity labels are derived from word frequency and are often incomplete or ambiguous (e.g. "ET Money · DAY" instead of "ET Money · SIP Payment").

The goal is to replace this with a proper **entity-relationship knowledge graph** extracted by an LLM from each email's subject and sender metadata, stored persistently in SQLite, and rendered using the existing Sigma.js + Graphology stack already in the renderer.

---

## Decision

### Architecture Overview

```
Vector Index Pipeline          Graph Index Pipeline
(existing, unchanged)          (new, independent)
        │                               │
  indexer.ts                  graph-extractor.ts
  ONNX embedding              LLM entity extraction
  LanceDB write               SQLite graph_* tables
  mails.indexed_meta='yes'    mails.graph_indexed='complete'
        │                               │
        └──────────┬────────────────────┘
                   │
           intelligence.js
           getKnowledgeGraph IPC
           Sigma + Graphology render
```

The two pipelines are **fully independent** — each owns a separate tracking column on the `mails` table and can run in parallel without conflict.

---

## Implementation Plan

### 1. SQLite Schema (`inboxpie-db.ts`)

**New column on `mails`** (added via `ALTER TABLE` migration, not changing `SCHEMA`):
```sql
ALTER TABLE mails ADD COLUMN graph_indexed TEXT NOT NULL DEFAULT 'todo'
  CHECK (graph_indexed IN ('todo','inprogress','complete'));
CREATE INDEX IF NOT EXISTS idx_mails_graph_indexed ON mails(graph_indexed);
```

This column is completely independent from `mails.indexed` (vector NER column). A mail can be `indexed='complete'` (vector done) and `graph_indexed='todo'` (graph pending) simultaneously.

**3 new tables:**
```sql
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         TEXT PRIMARY KEY,   -- sha1(lower(label)+':'+type)[0:16]
  label      TEXT NOT NULL,
  type       TEXT NOT NULL,      -- PERSON | ORG | PRODUCT | TOPIC | PLACE | EVENT
  frequency  INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id              TEXT PRIMARY KEY,  -- sha1(src+':'+tgt+':'+relation)[0:16]
  source_node_id  TEXT NOT NULL REFERENCES graph_nodes(id),
  target_node_id  TEXT NOT NULL REFERENCES graph_nodes(id),
  relation        TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 1.0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-mail → entity membership with folder/mailbox context
CREATE TABLE IF NOT EXISTS graph_mail_nodes (
  mail_id    TEXT    NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  mailbox_id TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  node_id    TEXT    NOT NULL REFERENCES graph_nodes(id),
  PRIMARY KEY (mail_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_gmn_node   ON graph_mail_nodes(node_id);
CREATE INDEX IF NOT EXISTS idx_gmn_folder ON graph_mail_nodes(folder_id);
```

**New DB methods:**
- `getPendingGraphMails(limit)` — `WHERE graph_indexed='todo'`
- `markMailGraphIndexing(id)` — sets `graph_indexed='inprogress'`
- `markMailGraphComplete(id, entities, nodeIds, folderId, mailboxId)` — transaction: write `subject_entities`, set `graph_indexed='complete'`, insert `graph_mail_nodes`
- `markMailGraphFailed(id)` — resets `graph_indexed='todo'`
- `upsertGraphNode(id, label, type)` — INSERT OR IGNORE + increment `frequency`
- `upsertGraphEdge(id, srcId, tgtId, relation)` — INSERT OR IGNORE + increment `weight`
- `getKnowledgeGraphData(limit=500)` — top-N nodes by frequency + their edges + stats
- `getGraphIndexStats()` — `{total, todo, inprogress, complete}` from `graph_indexed`
- `resetGraphIndex()` — clears all graph tables, resets `graph_indexed='todo'`

TypeScript types to add:
```typescript
export type GraphNode = { id: string; label: string; type: string; frequency: number };
export type GraphEdge = { id: string; sourceNodeId: string; targetNodeId: string; relation: string; weight: number };
```

---

### 2. Graph Extractor Service (`src/main/agent/graph-extractor.ts`) — NEW FILE

**LLM prompt** (batches of 10 emails per call):
```
Extract named entities and relationships from these email subjects and senders. Return only valid JSON.

Emails:
1. From: "ET Money" | Subject: "Your NPS contribution of ₹500 has been processed"
2. From: "HDFC Bank" | Subject: "Credit card statement for March 2025"
...

Return a JSON array with one entry per email (in order):
[
  {
    "entities": [{"text": "NPS", "type": "PRODUCT"}, {"text": "ET Money", "type": "ORG"}],
    "relationships": [{"source": "ET Money", "target": "NPS", "relation": "PROCESSES"}]
  },
  ...
]

Entity types: PERSON, ORG, PRODUCT, TOPIC, PLACE, EVENT
Keep entity text short (1-3 words). Skip generic words like "email", "notification", "account".
Relations: short uppercase verb phrases — OFFERS, PROCESSES, SENDS, PARTNERS_WITH, RELATED_TO
```

**Key functions:**
- `nodeId(label, type)` — `sha1(lower(label)+':'+type).hex[0:16]`
- `edgeId(srcId, tgtId, relation)` — same hash pattern
- `extractBatch(mails, llm)` — calls `llm.invoke(prompt)`, parses JSON, returns array matching input length
- `isGraphIndexAvailable()` — checks `getAISettings()` for configured provider + model
- `buildGraphIndexJob(onProgress, shouldCancel)`:

```
BATCH_SIZE = 10
loop:
  pending = getPendingGraphMails(10)
  if empty → break
  for each mail → markMailGraphIndexing(mail.id)
  results = extractBatch(pending, llm)
  for each (mail, result):
    for each entity → upsertGraphNode, collect nodeIds
    for each relationship → upsertGraphEdge
    markMailGraphComplete(mail.id, entities, nodeIds, folderId, mailboxId)
  onProgress({ done, total })
  await sleep(50)   // yield event loop
```

Uses `createLLM(provider, model, apiKey)` from `llm-providers.ts` (existing factory, unchanged).

---

### 3. IPC Handlers (`handlers.ts`)

**4 new IPC actions:**

`getKnowledgeGraph` — reads `graph_nodes` + `graph_edges` from SQLite, maps type to color, returns:
```typescript
{
  nodes: Array<{ id, label, type, frequency, color }>,
  edges: Array<{ sourceNodeId, targetNodeId, relation, weight }>,
  stats: { totalNodes, totalEdges, graphIndexed, total }
}
```

Node type → color palette:
```typescript
const TYPE_PALETTE = {
  ORG:     '#818cf8',  // indigo
  PERSON:  '#10b981',  // emerald
  PRODUCT: '#f59e0b',  // amber
  TOPIC:   '#f43f5e',  // rose
  PLACE:   '#14b8a6',  // teal
  EVENT:   '#f97316',  // orange
};
```

`buildGraphIndex` — checks `isGraphIndexAvailable()`, starts `buildGraphIndexJob` as background fire-and-forget, emits `graphIndex*` progress events.

`getGraphIndexStatus` — returns `getGraphIndexStats()`.

`resetGraphIndex` — calls `inboxPieDb.resetGraphIndex()`.

**Auto-trigger:** At the end of `runFolderIndexJob`, after vector indexing completes:
```typescript
const { available } = isGraphIndexAvailable();
if (available && !graphIndexRunning) void buildGraphIndexJob(...);
```

**New RpcAction variants** (in `message-record.ts`):
```typescript
| { action: "getKnowledgeGraph" }
| { action: "buildGraphIndex" }
| { action: "getGraphIndexStatus" }
| { action: "resetGraphIndex" }
```

**New ProgressEvent variants:**
```typescript
| { action: "graphIndexStarted"; total: number }
| { action: "graphIndexProgress"; done: number; total: number }
| { action: "graphIndexComplete"; nodes: number; edges: number }
| { action: "graphIndexError"; error: string }
```

---

### 4. Renderer: Clusters View (`intelligence.js`)

**Load sequence** — try knowledge graph first, fall back to K-means:
```javascript
browser.runtime.sendMessage({ action: 'getKnowledgeGraph' }).then(function(kg) {
  if (kg && kg.stats.totalNodes >= 5) {
    idRenderKnowledgeGraph(kg);
  } else {
    browser.runtime.sendMessage({ action: 'getCluster2D' }).then(idRenderGraph);
  }
});
```

**`idRenderKnowledgeGraph(kg)`** — new render function:

1. **Initial positions** — group by type, place each type at an angle on a circle with random jitter
2. **FR layout** — `idFRLayout(positions, edgePairs, 150)` (existing function, unchanged)
3. **Graphology construction:**
   - Node size = `2 + (frequency / maxFreq) * 8` (range 2–10px)
   - Node color from `node.color` (pre-computed by type in handler)
   - Node label = `node.label` (directly meaningful, no bigram heuristic)
   - Edges added invisible; bezier canvas overlay draws them (reuse `drawCurvedEdges` unchanged)
4. **Sigma init** — same options, same `drawChipLabel` renderer (unchanged)

**Sidebar** — groups by entity type:
```javascript
{ ORG: 12, PERSON: 5, PRODUCT: 8, TOPIC: 3, ... }
```
Click on type row → highlight all nodes of that type, dim others (same in-place dimming pattern as current cluster click).

**States:**
- If `graphIndexed < total`: show "Building knowledge graph… X / Y" progress banner; poll `getGraphIndexStatus` every 5s
- If `totalNodes === 0` and no LLM: show "Configure an AI model in Settings to enable Knowledge Graph" card with fallback button

---

## Files Modified

| File | Change |
|------|--------|
| `app/src/main/db/inboxpie-db.ts` | Add `graph_indexed` column migration + 3 tables + 8 new methods |
| `app/src/main/agent/graph-extractor.ts` | **CREATE** — LLM extraction + graph index job |
| `app/src/main/ipc/handlers.ts` | 4 new IPC actions + auto-trigger after vector index |
| `app/src/renderer/public/intelligence.js` | New `idRenderKnowledgeGraph()` + updated load sequence |
| `app/shared/message-record.ts` | 4 new RpcAction + 4 new ProgressEvent variants |

Files **not touched:** `indexer.ts`, `llm-providers.ts`, `langgraph-agent.ts`, `apple-mail.ts`, `shell.js`, `styles.css`.

---

## Key Design Decisions

**Why a dedicated `graph_indexed` column?**  
`mails.indexed` is owned by the vector NER pipeline. Sharing it would cause the two pipelines to block each other — whichever finishes first sets `'complete'` and the other skips the mail. With `graph_indexed` as a separate column both pipelines advance independently and can run truly in parallel.

**Why a background job after vector indexing, not inline?**  
ONNX embedding takes 200–500ms per email. An Ollama LLM call adds 1–5s per email — inline that makes indexing 5–15× slower. The graph job starts automatically when vector indexing finishes and emits its own progress events, keeping both pipelines independently observable.

**Why batch 10 emails per LLM call?**  
One call per email × 500 emails = 500 round trips. Batching 10 reduces to ~50 calls. For Ollama (~2s/call) that's ~100s vs ~1000s for per-email calls. Cloud providers are fast enough even single-email, but batching keeps costs negligible.

**Why deduplicated `graph_nodes` table instead of aggregating `subject_entities` JSON at query time?**  
`getKnowledgeGraphData` would need to deserialize thousands of JSON columns and aggregate in memory at every render. The `graph_nodes`/`graph_edges` tables give pre-aggregated weights and O(1) node lookup. `graph_mail_nodes` enables future "which emails mention this entity?" drill-down queries.

---

## Consequences

**Positive:**
- Graph labels are directly meaningful entity names ("ET Money", "NPS", "SIP Payment") — no heuristic bigrams
- Node size encodes real importance (frequency across all emails)
- Entity type coloring gives instant visual grouping
- Both pipelines independent — vector search unaffected if graph job is slow or fails
- Foundation for future "drill into entity" email list view

**Negative / Risks:**
- Requires a configured LLM (Ollama or cloud key) — no graph without AI model
- Graph index takes time for large inboxes (50–250s for 500 emails on Ollama)
- LLM extraction quality varies by model; smaller models may produce noisy entities
- `resetGraphIndex` wipes all extracted entities — no incremental update if LLM improves

---

## Verification

1. `npm run typecheck` — clean after schema + type additions
2. `npm run build` — `out/main/graph-extractor.js` present
3. Launch app → Intelligence tab → Clusters view shows progress banner while graph builds
4. After completion: Sigma graph shows entity nodes (ET Money, NPS, HDFC…) sized by frequency, colored by type
5. Cross-type edges visible (e.g. ORG→PRODUCT with "PROCESSES" relation)
6. Sidebar groups by entity type; clicking a type dims other nodes in-place
7. No LLM configured → "Configure AI model" card shown with K-means fallback button
8. `resetGraphIndex` clears tables and resets `graph_indexed='todo'`; re-trigger rebuilds fresh
9. Vector indexing (`indexed_meta`) unaffected — can run simultaneously without conflict
