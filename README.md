# Vanguard MCP

Live: https://vanguard-mcp.netlify.app/

**Public money, verified.** Ask a plain-English question about a budget, a grant, or a line of spending and get an answer in which *every figure* has been checked against the source records before you see it, or an explicit refusal. Never an unverified number presented as fact.

[![Core tests](https://img.shields.io/badge/core-165%20tests%2C%20offline-blue.svg)](vanguard-core/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

The issue is that AI is excellent at turning a question into SQL, and terrible at being trusted with the math. So we took the AI out of the equation. The LLM (AI) writes a query, a read-only database returns the rows, and a verifier checks that every number in the prose actually came from those rows. What you get back is either a grounded answer with a full provenance trail, or an explicit refusal. Never an unverified paragraph presented as fact.

Why this matters for the public sector: a resident, a council member, or an auditor should be able to ask *"how much of the paving grant was actually spent, and on what?"* and get a number they can trace to the record and reproduce later, not a figure from a dashboard they have to take on faith. Every answer is hash-chained into a tamper-evident log, so a published figure cannot be quietly changed after the fact.

```
question
   ├─ plan      model writes SQL, having never seen a row of data
   ├─ guard     parsed, SELECT-only, allow-listed, LIMIT enforced   ← refuses here
   ├─ execute   read-only connection                                ← refuses here
   ├─ narrate   prose written, then every number checked against the rows
   ├─ lineage   SQL + tables + columns + row count + result hash
   └─ audit     appended to a hash-chained log
```

## The four guarantees, and what enforces each

A claim is only worth what enforces it. Each guarantee is backed by a mechanism and a test that would fail if it broke, not by a promise.

| Guarantee | Enforced by |
|-----------|-------------|
| The model cannot write to the database | A connection opened `readOnly: true`; SQLite refuses writes below anything the code can reach |
| Only SELECT, only allow-listed tables/columns, always bounded | `guard.js` parses SQL to an AST and inspects the full table list, including subqueries and CTE bodies |
| Every figure in the prose came from the data | `grounding.js` extracts each number and matches it to a returned value, allowing only legitimate transforms (cents to currency, ratio to percent) |
| A past answer cannot be altered unnoticed | `audit.js` hash-chains each entry to the one before it; `verify()` reports the first index where the chain breaks |

The engine is **schema-agnostic**: the guard, grounding, lineage and audit chain are identical regardless of the data. Pointing it at a municipal chart of accounts, a grant ledger, or a checkbook register is a new schema and allow-list, not new plumbing.

## What's in this repo

| Path | What it is |
|------|-----------|
| [`vanguard-core/`](vanguard-core/) | **The working engine.** A Node.js CLI and library implementing the full pipeline above: guard, read-only warehouse, grounding verifier, lineage capture, and a tamper-evident audit chain. 165 tests, no API credential required to run them. |
| [`site/`](site/) | **The web demo.** A static site: the thesis, the reporting-gap case study, and the evidence panel. |
| [`site/enron.html`](site/enron.html) | **The reporting-gap case study**, reported figures set against what the underlying rows support, each grounded and hash-chained. |
| [`site/controls.html`](site/controls.html) | **The evidence panel**, one-click controls that return PASS/EXCEPTION with a verifiable evidence trail. |

The demo makes the case; the core makes it executable. Start with the [`vanguard-core/` README](vanguard-core/README.md) for the full technical account.

## The reporting-gap problem

The distance between what an entity *reports* and what its records actually *support* is the core risk Vanguard MCP exists to surface, in a corporate filing or a town budget. The same reconciliation (reported figure vs what the ledger supports) is exactly what a municipality needs for grant drawdowns, bond-proceeds spending, and year-end reporting.

The included case study uses Enron's FY2000 figures because they are public and well understood: revenue booked *gross* ($100,789m reported) against the *net* margin actually earned ($1,953m), and reported debt ($10,229m) against the true total once off-balance-sheet entities are included. The engine computes the reported figure *and* the underlying figure in one guarded, read-only query, then hash-chains the result, so the gap is a reproducible, tamper-evident fact, not an assertion. The headline aggregates reconcile to Enron's **real** reported figures (SEC accession `0001024401-01-500010`); the transaction-level rows are synthetic and labelled so.

## Continuous attestation

The evidence panel turns a question into a one-click **control** that returns **PASS** or **EXCEPTION** with a full provenance trail: processing-integrity checks (do reported figures reconcile to source records?), figure reproducibility, and audit-chain integrity. For a municipality, this is the mechanism behind "show me the evidence, not the dashboard", a packet an auditor can recompute, not a chart to trust.

## Quick start

```bash
cd vanguard-core
npm install
npm run seed            # build the demo warehouse
npm test                # 165 tests, no credential required

# Reporting-gap case study (no credential, real 10-K anchors, synthetic rows)
node bin/vanguard.js enron seed
node bin/vanguard.js enron revenue     # reported (gross) vs margin actually earned (net)
node bin/vanguard.js enron debt        # reported debt vs true debt incl. off-balance-sheet entities

# Evidence controls (PASS / EXCEPTION + provenance)
node bin/vanguard.js controls list
node bin/vanguard.js controls run PI1.2-enron-debt-reconciliation

# Verify the tamper-evident audit chain end to end
node bin/vanguard.js audit

# Ask in plain English, planning and narration call a model (set the key first)
export ANTHROPIC_API_KEY=...
node bin/vanguard.js ask "your question about the seeded demo data"
```

The guard, the warehouse, the lineage record, and the audit chain all run with no credential; only the plan and narrate steps call the model. **Node 22+ is required** (`node:sqlite` is used).

## What is real, and what is not

In keeping with the project's own discipline about claims:

- **Real:** the guard (table and column allow-lists, a query budget, a row-level scope hook driven by an authenticated principal), read-only enforcement behind a warehouse-connector interface, unit-aware grounding, lineage capture and hashing, the hash-chained audit log with Ed25519 signing and a pluggable external-anchoring hook, a first-class metric registry, the CLI, and the offline test suite (165 tests, no credential).
- **Synthetic:** the demo warehouse **values**, generated deterministically so the same question always produces the same result hash. The reporting-gap study's *aggregates* reconcile to real, cited FY2000 10-K figures; its transaction rows and off-balance-sheet amounts are synthetic and labelled. For a tool about traceable figures, fabricated data clearly labelled as fabricated is fine; fabricated data presented as real is the exact failure this project exists to prevent.
- **Not a compliance claim:** audit entries carry tags like `processing-integrity` because the query path is read-only over a schema with no personal data, a true statement about this configuration, not a certification. What this produces is *evidence*: a query, its provenance, a reproducible hash of its result, and a chain showing the record has not been edited since.

## Requirements

Node 22+ (`node:sqlite` is built in, so there is no native database dependency to compile). Planning and narration call a large language model; the API key is read from the environment (see the quick start). The guard, warehouse, grounding, lineage, and audit chain run entirely offline.

## License

MIT.
