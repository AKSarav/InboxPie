# Architecture Decision Records (ADRs)

This directory documents major architectural decisions for InboxPie Desktop.

---

## Decision Records

| ADR | Title | Status | Key Decision |
|-----|-------|--------|--------------|
| 001–006 | Foundation (entity extraction, enrichment DB, KnowledgeMap, model distribution, privacy, SmartSearch) | **IMPLEMENTED** | See individual files for historical detail |
| [007](./007-llm-knowledge-graph-clusters.md) | LLM Knowledge Graph for Clusters View | PROPOSED | Dedicated `graph_indexed` column; LLM entity extraction pipeline independent from vector index; entity-relationship graph replaces K-means clusters in Intelligence view |

---

## Key Architecture Principles

1. **Privacy-First:** No email bodies or subjects stored; only metadata and extracted entities
2. **Local-First:** All processing on-device; no data leaves the machine
3. **Isolation:** Each pipeline (vector index, graph index) tracks progress independently
4. **User Control:** Users can inspect, delete, or disable enrichment at any time
5. **Progressive:** Features degrade gracefully when AI model is not configured

---

## Related Files

- **App README:** [../README.md](../README.md)
- **Project CLAUDE.md:** [../../CLAUDE.md](../../CLAUDE.md)
- **Decisions Summary:** [DECISIONS_SUMMARY.md](./DECISIONS_SUMMARY.md)
