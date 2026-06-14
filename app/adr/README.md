# Architecture Decision Records (ADRs)

This directory documents major architectural decisions for InboxPie Desktop enhancements, specifically the integration of **entity extraction**, **semantic search**, and **knowledge graph** capabilities.

## Overview

InboxPie Desktop is evolving from a read-only analytics dashboard (port of Thunderbird extension) to a **smart email analysis tool** with AI-powered features:

- **SmartSearch:** Entity-aware SQL queries (find emails from ACME Corp, conversations between people, etc.)
- **KnowledgeMap:** Semantic relationships and organization hierarchies powered by Gliner2 NER + FolklorDBLite graph DB
- **Ontology:** Structured reasoning to infer roles (hubs, decision-makers, gatekeepers) and team structures

All processing happens **locally on-device**; no data leaves the user's machine.

---

## Decision Records

| ADR | Title | Status | Key Decision |
|-----|-------|--------|--------------|
| [001](./001-entity-extraction-pipeline.md) | Entity Extraction Pipeline | PROPOSED | Progressive enrichment as background task post-scan |
| [002](./002-enrichment-database-design.md) | Enrichment Database Design | PROPOSED | Separate SQLite DB for aggregations + entities (no content) |
| [003](./003-knowledgemap-architecture.md) | KnowledgeMap Architecture | PROPOSED | Gliner2 NER + FolklorDBLite + ontology rules |
| [004](./004-gliner2-model-distribution.md) | Gliner2 Model Distribution | PROPOSED | Lazy download with progress, local cache at ~/.inboxpie/models/ |
| [005](./005-security-and-privacy-considerations.md) | Security & Privacy | PROPOSED | Data minimization, isolation, audit, user control |
| [006](./006-smartsearch-powered-by-sql.md) | SmartSearch Query Engine | PROPOSED | Hybrid SQL + SPARQL queries on enrichment DB |

---

## Implementation Roadmap

### Phase 1: Foundation (MVP)
- [ ] Create enrichment.db schema (ADR 002)
- [ ] Implement entity extraction pipeline (ADR 001)
- [ ] Integrate Gliner2 with lazy download (ADR 004)
- [ ] Build basic relationship graph (ADR 003)
- [ ] Add simple SmartSearch UI for entity queries (ADR 006)

### Phase 2: KnowledgeMap
- [ ] Implement FolklorDBLite graph layer
- [ ] Add ontology rules (hubs, gatekeepers, team detection)
- [ ] Visualize knowledge graph in dashboard
- [ ] Extend SmartSearch to relationship queries

### Phase 3: Polish
- [ ] Natural language query parser (if needed)
- [ ] Encryption at rest (ADR 005)
- [ ] Audit logging
- [ ] User controls (delete cache, disable enrichment)

---

## Key Architecture Principles

1. **Privacy-First:** No email bodies or subjects stored; only metadata and extracted entities
2. **Local-First:** All processing on-device; no cloud APIs except model downloads
3. **Isolation:** Enrichment DB separate from Apple Mail; each can be encrypted independently
4. **User Control:** Users can inspect, delete, or disable enrichment at any time
5. **Progressive:** Features degrade gracefully (SmartSearch unavailable if enrichment stalls)
6. **Extensible:** Add new entity types, ontology rules, query types without major refactoring

---

## Related Files

- **App README:** [../README.md](../README.md)
- **Project CLAUDE.md:** [../../CLAUDE.md](../../CLAUDE.md)
- **Privacy Policy:** [../../THUNDERBIRD/PRIVACY.md](../../THUNDERBIRD/PRIVACY.md)

---

## Questions for Future Decisions

- Should enrichment DB be encrypted by default? (See ADR 005)
- What's the fallback if Gliner2 download fails? (See ADR 004)
- How often should the knowledge graph be refreshed? (See ADR 003)
- Should we support natural language queries, or stick to structured DSL? (See ADR 006)
- Can we share entity extraction or aggregations with the CLI? (Future: shared analytics module)

---

## Contributors

These ADRs were designed collaboratively to extend InboxPie Desktop with AI-powered features while maintaining the core privacy and local-first principles.

**Status:** All ADRs in PROPOSED state; awaiting implementation and team review.
