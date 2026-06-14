# InboxPie Desktop Feature Enhancement: Decisions Summary

**Date:** 2026-06-04  
**Context:** Extending the Electron app from a read-only dashboard to a smart email analysis tool with entity extraction, semantic search, and knowledge graphs.

---

## The Vision

Transform InboxPie Desktop from **"visualize my inbox"** to **"understand my email network"**:

```
Current (Read-Only Dashboard)          Enhanced (SmartSearch + KnowledgeMap)
├─ PieView sunburst                    ├─ All current features
├─ By Sender / Domain / Size           ├─ SmartSearch: "emails from ACME Corp"
├─ Timeline                            ├─ KnowledgeMap: who talks to whom
└─ Selection + Export (no moves)       └─ Ontology: find decision-makers, hubs

All local, no content stored, user-controlled.
```

---

## Six Key Decisions

### 1️⃣ **When to Extract Entities?** → Progressive Background Task

**Decision (ADR 001):**  
Scan completes synchronously → dashboard renders immediately → entity extraction happens asynchronously in the background.

**Why:** Fast UX, users explore while NER happens silently, graceful fallback if enrichment stalls.

**Code flow:**
```
User scans mailbox
  ↓
Fast: Load messages, compute aggregations
  ↓
Dashboard is interactive (PieView, timeline visible)
  ↓
Slow: Background worker extracts entities (Gliner2 NER)
  ↓
Update UI when enrichment completes
```

---

### 2️⃣ **Where to Store Aggregations and Entities?** → Separate Enrichment DB

**Decision (ADR 002):**  
Create `~/.inboxpie/enrichment.db` — isolated SQLite that stores:
- ✅ Aggregations (sender stats, domain stats, time series)
- ✅ Extracted entities (people, orgs, topics)
- ✅ Relationship edges (A emailed with B)
- ❌ NO email bodies, subjects, or content

**Why:** Privacy by design, easy to audit, can be encrypted independently, regenerable if corrupted.

**Schema highlight:**
```sql
entities (id, text, type, confidence)     -- "John Doe", "person", 0.92
relationships (id, entity_a_id, entity_b_id, type, strength)  -- emailed_with, count=47
sender_stats (sender, domain, message_count, total_size)
```

---

### 3️⃣ **How to Build Semantic Understanding?** → Gliner2 + FolklorDBLite + Ontology

**Decision (ADR 003):**  
Three-layer semantic stack:

```
Layer 1: Gliner2 NER          → Extract entities from metadata
          (people, orgs, topics, locations, confidence scores)

Layer 2: FolklorDBLite Graph  → Store RDF triples (relationships)
         + SQL relationships   → (john) --[emailed_with]--> (sarah)

Layer 3: Ontology Rules       → Reason about roles
         (IF high frequency    → (john) is a "hub"
          THEN hub status)     → (john) "bridges" org_a and org_b
```

**Why:** Expressive reasoning, local-first, extensible, proven pattern (semantic web).

**Example query after ontology:**
```sparql
SELECT ?person WHERE {
  ?person rdf:type "person" ;
          "has_role" "decision_maker" ;
          "emailed_with" ?other ;
          "organization" ?org .
}
```

---

### 4️⃣ **How to Ship the NER Model?** → Lazy Download with Cache

**Decision (ADR 004):**  
- First use: Detect missing Gliner2 model, download from Hugging Face (~1-2 GB) to `~/.inboxpie/models/`
- Subsequent uses: Load from cache (instant)
- Fallback: If download fails, skip enrichment gracefully
- Optional: `inboxpie-setup --download-models` for offline pre-download

**Why:** Keeps app binary small, users only download if they use SmartSearch, flexible model swaps.

**Flow:**
```
enrichmentWorker.start()
  → GlinerModelLoader.ensureModel()
    → cache exists? → load instantly
    → cache missing? → download (progress bar)
    → download fails? → skip enrichment, show warning
```

---

### 5️⃣ **How to Protect Privacy and Audit?** → Data Minimization + Schema Validation

**Decision (ADR 005):**  
Enforce at code and schema levels:

✅ **What we store:**
- Sender addresses, domain stats (already public)
- Extracted entity names (no context)
- Relationship edges (A talks to B, frequency)

❌ **What we NEVER store:**
- Email bodies, subjects, recipients
- Attachment names, full headers
- Any message content beyond sender/date/folder/size

**Protection mechanisms:**
```typescript
// Whitelist allowed table columns
private ALLOWED_COLUMNS = {
  entities: ['id', 'text', 'type', 'confidence'],
  // NOT 'message_body', 'subject', 'full_text'
};

// Assert entity text isn't a body
if (entity.text.length > 256 || entity.text.includes('\n\n')) {
  throw new Error('Entity text suspiciously long; aborting insert');
}
```

**User controls:**
- Inspect enrichment DB via Settings → "Show Entity Cache Summary"
- Delete cache anytime: Settings → "Clear Entity Cache"
- Disable entirely: Settings → "Disable SmartSearch & KnowledgeMap"
- Optional encryption at rest: PRAGMA key = ...

---

### 6️⃣ **How to Enable Semantic Search?** → Hybrid SQL + Graph Queries

**Decision (ADR 006):**  
SmartSearch bridges SQL aggregations and graph relationships:

**Query types:**
- **Entity query:** "Find all emails from ACME Corp" → SQL on sender_stats
- **Relationship query:** "Conversations between John and Sarah" → SQL + entity matching
- **Topic query:** "Emails mentioning Project X" → Entity join queries
- **VIP query:** "Decision-makers in Q3" → Ontology role lookup
- **Combined:** "Find decision-makers from ACME who mention Project X" → SQL + SPARQL

**Example translation:**

| User Input | Query Engine | SQL/SPARQL |
|---|---|---|
| "Emails from ACME" | Entity → SQL | `WHERE domain = 'acme.com'` |
| "John and Sarah conversation" | Relationship → SQL | Join sender + recipients |
| "Who influences this org?" | VIP → Ontology | `?person has_role "hub"` |

**UI:** Results render in existing Review modal (select, export CSV).

---

## Architecture in One Picture

```
┌─────────────────────────────────────────────────────────────┐
│                     InboxPie Desktop                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐          ┌──────────────────┐            │
│  │ Dashboard    │  ←→      │ Enrichment DB    │            │
│  │              │          │                  │            │
│  │ • PieView    │          │ • Aggregations   │            │
│  │ • Timeline   │          │ • Entities       │            │
│  │ • By Sender  │  async   │ • Relationships  │            │
│  │ • SmartSearch│  workers │ • Search index   │            │
│  └──────────────┘          └──────────────────┘            │
│                                    ↑                        │
│                            Entity extraction                │
│                         Gliner2 + FolklorDBLite             │
│                           + Ontology rules                  │
│                                                              │
│  ┌──────────────────────────────────────────────────┐      │
│  │        Apple Mail (READ-ONLY, untouched)         │      │
│  │  • Envelope Index (SQLite)                       │      │
│  │  • .emlx files                                   │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Principles Enforced Across All Decisions

1. **Privacy by Design**  
   Data minimization at schema level; whitelisting in code; user controls visible in Settings.

2. **Local-First**  
   All processing on-device; no API calls except Gliner2 model download (HTTPS verified).

3. **User Control**  
   Users can delete cache, disable enrichment, inspect what's stored.

4. **Progressive Enhancement**  
   Dashboard works without enrichment (degrades gracefully); SmartSearch available when ready.

5. **Separation of Concerns**  
   Apple Mail untouched; enrichment isolated; can be rebuilt from scratch.

---

## Implementation Phases

```
Phase 1: Foundation (MVP)
├─ Create enrichment.db schema
├─ Implement entity extraction (background task)
├─ Integrate Gliner2 (lazy download)
└─ Basic SmartSearch (entity queries only)
  Duration: ~4-6 weeks

Phase 2: KnowledgeMap
├─ Add FolklorDBLite graph layer
├─ Implement ontology rules
├─ Visualize relationships in dashboard
└─ Extend SmartSearch (relationship + VIP queries)
  Duration: ~6-8 weeks

Phase 3: Polish & Shipping
├─ Encryption at rest (optional)
├─ Audit logging
├─ User controls (Settings UI)
├─ Natural language query parser (if needed)
└─ Privacy policy update
  Duration: ~2-4 weeks
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Gliner2 model too large? | Lazy download + optional pre-download command |
| Entity extraction slow? | Background task (ADR 001) doesn't block UI |
| Privacy regression? | Schema validation + code review (ADR 005) |
| Entity disambiguation fails? | Fallback to string matching; lower confidence threshold |
| Knowledge graph slow? | Pre-computed indexes + incremental updates |
| Users concerned about storage? | Clear audit trail, easy delete, Settings UI transparency |

---

## Success Criteria

- ✅ SmartSearch finds emails across organization boundaries ("all ACME emails")
- ✅ KnowledgeMap visualizes team structures and influence
- ✅ Zero email bodies stored; easy to audit
- ✅ Users can delete enrichment cache without losing scan data
- ✅ Background enrichment doesn't impact dashboard responsiveness
- ✅ Works offline once models are cached

---

## Next Steps

1. **Review & Alignment** → Get team feedback on all 6 ADRs
2. **Refine Details** → Implementation specs for Phase 1
3. **Set Up Infrastructure** → Enrichment DB creation, Gliner2 integration, worker threading
4. **Iterate & Test** → MVP with entity extraction + basic SmartSearch
5. **Measure & Improve** → Gather user feedback on performance, UX, privacy concerns

---

## Reference Documents

- [ADR 001: Entity Extraction Pipeline](./001-entity-extraction-pipeline.md)
- [ADR 002: Enrichment Database Design](./002-enrichment-database-design.md)
- [ADR 003: KnowledgeMap Architecture](./003-knowledgemap-architecture.md)
- [ADR 004: Gliner2 Model Distribution](./004-gliner2-model-distribution.md)
- [ADR 005: Security & Privacy Considerations](./005-security-and-privacy-considerations.md)
- [ADR 006: SmartSearch Query Engine](./006-smartsearch-powered-by-sql.md)

---

**Status:** ✏️ PROPOSED  
**Owner:** InboxPie Desktop Team  
**Last Updated:** 2026-06-04
