# InboxPie Desktop — Architecture Decisions Summary

**Last Updated:** 2026-07-17

---

## Implemented (ADRs 001–006)

The foundational decisions covering entity extraction pipeline, enrichment database design, KnowledgeMap architecture, Gliner2 model distribution, security & privacy, and SmartSearch query engine have all been implemented. The individual ADR files (001–006) are retained for historical reference.

---

## Current — ADR 007: LLM Knowledge Graph for Clusters View

**Status:** PROPOSED

Replaces the K-means word-frequency clusters in the Intelligence view with a proper entity-relationship knowledge graph extracted by an LLM from each email's subject and sender metadata.

**Key decisions:**
- Dedicated `graph_indexed` column on `mails` — fully independent from the vector index pipeline; both can run in parallel without conflict
- 3 new SQLite tables: `graph_nodes`, `graph_edges`, `graph_mail_nodes` (with `folder_id` + `mailbox_id` per mail)
- New background service `graph-extractor.ts` — batches 10 emails per LLM call using the existing `createLLM()` factory
- Clusters view tries `getKnowledgeGraph` first; falls back to `getCluster2D` (K-means) if no graph data exists
- Nodes sized by entity frequency, colored by type (ORG, PERSON, PRODUCT, TOPIC, PLACE, EVENT)
- No changes to `indexer.ts`, `llm-providers.ts`, or any existing pipeline

See [ADR 007](./007-llm-knowledge-graph-clusters.md) for the full implementation plan.

---

## Key Principles (unchanged)

1. **Privacy-First** — no email bodies stored; only metadata and extracted entities
2. **Local-First** — all processing on-device
3. **User Control** — users can reset/disable graph indexing at any time
4. **Progressive** — dashboard works without graph data; features degrade gracefully
5. **Separation of Concerns** — graph pipeline independent of vector pipeline
