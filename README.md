# Civic-Chain Grant & Budget Auditor

From [civic-chain.com](https://civic-chain.com). Live demo: https://vanguard-mcp.netlify.app/

**Public money, verified.** Ask a plain-English question about a budget, a grant, or a line of spending and get an answer in which *every figure* has been checked against the source records before you see it, or an explicit refusal. Never an unverified number presented as fact.

[![Core tests](https://img.shields.io/badge/core-436%20tests%2C%20offline-blue.svg)](vanguard-core/)
[![Licence: Civic-Chain Commercial, source-available](https://img.shields.io/badge/licence-source--available-informational.svg)](LICENSE)

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
| A past answer cannot be altered unnoticed | `audit.js` hash-chains each entry to the one before it; `verify()` reports the first index where the chain breaks. Optional Ed25519 signing and a pluggable external anchor extend this to a full rewrite of history |

The engine is **schema-agnostic**: the guard, grounding, lineage and audit chain are identical regardless of the data. Pointing it at a municipal chart of accounts, a grant ledger, or a checkbook register is a new schema and allow-list, not new plumbing.

## How the hashing works: two hashes, three layers

The system uses hashing for two separate jobs, and keeping them separate is the whole point. The full account is in **[HASHING.md](HASHING.md)**; the short version:

- **The result hash** answers *does the answer reproduce?* It is computed over the **rows the database returned**, after canonicalizing them (stable row order, stable value formatting). Re-run the same SQL at the same as-of date against the same snapshot and you get the same hash; a different hash means the data, the query, or the as-of date changed. The question is deliberately *not* part of it, because the same question can produce different SQL on different days. This is what an auditor recomputes, what an eval compares against a canonical query, and what makes caching safe.

- **The entry hash** answers *was anything edited?* Every query is written to an append-only log (JSON Lines). Each entry records the event, the question, SQL, tables/columns, the result hash, and whether narration was grounded, and each entry's hash includes the hash of the entry before it. Editing or dropping any past entry breaks that entry's hash, breaks the next entry's `prevHash`, and fails every entry after it; `verify()` reports the first index where the chain breaks. (The prose answer itself is *not* stored, only the grounding verdict, since the prose is reproducible from the SQL and data.)

A plain hash chain has one gap: someone with full write access could rewrite *every* entry from an edit point onward and recompute all the hashes. Two optional layers close it:

| Layer | Protects against | Status |
|-------|------------------|--------|
| **Hash chain** | Accidental corruption; editing or dropping a single entry | Always on |
| **+ Ed25519 signing** | Rewriting the chain without the private key | Implemented, opt-in via a signer |
| **+ External anchor** | An admin *with* the key rewriting history | Pluggable hook, not yet wired to a destination |

The external anchor **does not have to be a blockchain**, publishing each checkpoint hash to WORM storage, an RFC 3161 timestamp authority, or simply handing it to the auditor all work; a public chain is for the trust-no-one case. For a regulated client, signed entries plus periodic anchoring to WORM storage or a timestamp authority is usually the better fit. And the honest framing throughout: the log is **tamper-evident**, not immutable, it makes changes detectable, it does not make them impossible.

## What's in this repo

| Path | What it is |
|------|-----------|
| [`vanguard-core/`](vanguard-core/) | **The working engine.** A Node.js CLI and library implementing the full pipeline above: guard, read-only warehouse, grounding verifier, lineage capture, a tamper-evident audit chain, a CSV importer that builds a guarded warehouse from a buyer's own ledger, signed domain rulesets, and a one-command shareable audit report. 436 tests, no API credential required to run them. |
| [`site/`](site/) | **The web demo.** A static site: the thesis, the reporting-gap case study, and the evidence panel. |
| [`site/enron.html`](site/enron.html) | **The reporting-gap case study**, reported figures set against what the underlying rows support, each grounded and hash-chained. |
| [`site/controls.html`](site/controls.html) | **The evidence panel**, one-click controls that return PASS/EXCEPTION with a verifiable evidence trail. |
| [`site/value.html`](site/value.html) | **The value-proposition page**, why this brings Big-Four-caliber assurance to a municipality at software cost. |
| [`skills/civic-chain-auditor/`](skills/civic-chain-auditor/SKILL.md) | **The agent skill**, teaches an MCP host (Claude, Cursor, etc.) to route questions to the right tool, handle guard refusals, and present every figure with its result hash and audit entry. |
| [`HASHING.md`](HASHING.md) | **The hashing explainer**, the result hash vs the entry hash, the chain, and the signing/anchoring layers above it, in full. |
| [`SECURITY.md`](SECURITY.md) | **The security policy**, how to report a vulnerability, what runs locally (no telemetry), and the ruleset signing key's published fingerprint so you can pin it. |
| [`COMPARISON.md`](COMPARISON.md) | **The landscape**, how this relates to and differs from governed text-to-SQL, claim verifiers, and database ledgers. |

The demo makes the case; the core makes it executable. Start with the [`vanguard-core/` README](vanguard-core/README.md) for the full technical account.

## Architecture and data flow

One engine, two front doors. The pipeline at the top of this README (guard, execute, ground, lineage, audit) is the same code in both paths below; what differs is the transport in front of it and who is allowed to call what. The engine never trusts its caller: it enforces read-only access, the SELECT-only guard, grounding, and the hash chain regardless of how a request arrives.

The engine speaks two protocols from the one `vanguard-core` codebase:

- **stdio MCP**, the Model Context Protocol over a pipe, used by the agent skill below — the way a buyer runs the engine.
- **HTTP** (`cc-auditor serve`), a token-guarded JSON API, kept for enterprise server-to-server use. It refuses to start without `ENGINE_SERVICE_TOKEN`.

The public web demo uses neither: it runs the engine **in the browser**.

### The browser demo: the engine runs on the visitor's page

The public demo at **https://vanguard-mcp.netlify.app/demo.html** reads a synthetic ledger (the fictional Town of Sampleton) and runs three named queries, their checks, the guard, result hashing and the audit chain **entirely in the visitor's browser**. There is no server, no proxy and no endpoint to attack: the privacy story is literally "this page sends nothing anywhere," enforced by a `connect-src 'self'` Content-Security-Policy.

```
 browser (Netlify static site)
 site/demo.html
   ├─ sql-wasm.js + sql-wasm.wasm   WebAssembly SQLite (in-memory, read-only)
   └─ demo-engine.js                the real engine, bundled from vanguard-core:
                                    guard · named queries · lineage · audit chain
                                    audit chain persists in localStorage, per visitor
```

Step by step, what happens when a visitor runs a grant-status query:

1. **The page loads** `sql-wasm.js`/`sql-wasm.wasm` and `demo-engine.js` (an ES module built by `npm run build:demo`), all self-hosted from `assets/`. After that, the Network tab stays silent: nothing else is fetched for the rest of the session.
2. **A WASM SQLite database** is built in memory from the inlined seed SQL, then switched to `PRAGMA query_only = ON` — the browser equivalent of the Node engine's read-only file handle.
3. **The query runs through the same engine source a buyer runs.** `demo-engine.js` bundles the actual `guard.js`, `named-core.js`, `lineage.js` and `audit-core.js`; only the leaves differ — SQLite is WASM instead of `node:sqlite`, and hashing is a dependency-free pure-JS SHA-256 instead of `node:crypto`. A parity test (`test/browser-parity.test.js`) pins that both produce **identical result hashes**.
4. **The result is appended to a hash-chained audit log in `localStorage`** — one chain per visitor. *Verify the audit chain* recomputes it and reports `INTACT`; a *Tamper with an entry* button lets the visitor corrupt an entry and watch the next verify report the broken index. That demonstration is only possible because the chain is local.
5. **The response shape matches the MCP `run_canonical` tool exactly** (rows, `integrity`, `findings`, `checks`, `provenance`), via a single shared `provenanceOf`, so the demo cannot drift from the tool a buyer calls.

Because the engine is bundled, it is downloadable from the page. That is accepted: the product is source-available by decision, and the bundle carries the licence (see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)). Build and deploy details are in [`deploy/README.md`](deploy/README.md).

### The agent skill: MCP host → MCP server → engine

[`skills/civic-chain-auditor/`](skills/civic-chain-auditor/SKILL.md) is an **Agent Skill**: an operating manual that teaches an MCP host (Claude Code, Claude Desktop, Cursor) to drive the Civic-Chain Auditor as a set of tools and to keep the no-unverified-number guarantee intact on the model's side of the conversation. There is no HTTP proxy here; the host launches the engine as a local MCP server over stdio and talks to it directly, with the operator's own warehouses and (if a warehouse allows free text) their own API key.

```
 you ──▶ MCP host (model)  ──stdio MCP──▶  vanguard mcp (MCP server)  ──▶  engine pipeline
         routes per SKILL.md                 same guard/ground/audit          operator's warehouses
         presents, never computes            as HTTP, different transport     + audit chain
```

Step by step:

1. **Setup (once).** `scripts/verify-setup.js` checks the core and prints an `mcpServers` block; pasting it into the host and restarting registers the server. The host then launches `node vanguard-core/bin/vanguard.js mcp`, a stdio MCP server exposing the same tools (`run_canonical`, `run_query` and `verify_answer` for credential-free open-ended SQL, `execute_financial_query`, `list_controls` / `run_control`, `verify_audit`, and `propose_csv_mapping` / `import_csv` when an import folder is configured) and the `civic-chain://warehouses` resource.
2. **The host routes the question.** Guided by `SKILL.md`, the model reads `civic-chain://warehouses` to see what is connected, then prefers a named canonical query (`run_canonical` on `<warehouse>/<query>`, credential-free, operator-fixed definitions, and automatic integrity checks) and falls back to `execute_financial_query` only for free-text questions on a warehouse that permits them. It phrases the question so the SQL returns every figure it will quote, because a figure the query did not return cannot be grounded.
3. **The MCP server runs the same pipeline** the HTTP path does: guard, read-only execute, grounding, lineage, hash-chained audit. A malformed or out-of-policy request is refused by the engine, not by the skill; the refusal is the system working.
4. **The host presents the result in three parts** and does no arithmetic of its own: the grounded answer (figures exactly as returned), the provenance (executed SQL, tables and columns, row count), and the audit trail (result hash, audit sequence and entry hash, each check's verdict). For a named query it reads `integrity` before anything else: an `integrity: "flag"` result must not be presented as fact, and each `finding` is an audit observation about the ledger, not an error.

The engine is the same in both paths, so an answer obtained through the browser demo and the same answer obtained through the agent skill carry the same result hash and land in the same kind of tamper-evident chain — a parity test asserts it. The browser demo is the click-through proof; the skill is how an operator wires the Auditor into their own agent against their own books. Full tool reference, routing rules, and worked transcripts are in [`skills/civic-chain-auditor/SKILL.md`](skills/civic-chain-auditor/SKILL.md) and its `references/`.

## The reporting-gap problem

The distance between what an entity *reports* and what its records actually *support* is the core risk the Civic-Chain Auditor exists to surface, in a corporate filing or a town budget. The same reconciliation (reported figure vs what the ledger supports) is exactly what a municipality needs for grant drawdowns, bond-proceeds spending, and year-end reporting.

The included case study uses Enron's FY2000 figures because they are public and well understood: revenue booked *gross* ($100,789m reported) against the *net* margin actually earned ($1,953m), and reported debt ($10,229m) against the true total once off-balance-sheet entities are included. The engine computes the reported figure *and* the underlying figure in one guarded, read-only query, then hash-chains the result, so the gap is a reproducible, tamper-evident fact, not an assertion. The headline aggregates reconcile to Enron's **real** reported figures (SEC accession `0001024401-01-500010`); the transaction-level rows are synthetic and labelled so.

## Continuous attestation

The evidence panel turns a question into a one-click **control** that returns **PASS** or **EXCEPTION** with a full provenance trail: processing-integrity checks (do reported figures reconcile to source records?), figure reproducibility, and audit-chain integrity. For a municipality, this is the mechanism behind "show me the evidence, not the dashboard", a packet an auditor can recompute, not a chart to trust.

## Sample audit packs included

Because the engine is schema-agnostic, a domain pack is just a signed ruleset (named queries plus their checks) over a warehouse's allow-list. Each control is explicit column allow-lists (no `SELECT *`, no PII), deterministic SQL so the model does zero math, and an automatic PASS / EXCEPTION / FLAG check. The bundled packs show the range:

| Pack | Controls it ships | Catches |
|---|---|---|
| **Municipal & Grant** | grant status and drawdowns vs expenditures, spending by vendor, budget variance | Grant cash drawn ahead of spending, overspent lines, vendor concentration |
| **Insurance & Fiduciary** | premium-trust solvency, carrier commission variance, errors-and-omissions exposure on unbound policies | Commingled or short premium-trust funds, under-paid or charged-back commissions, client premium held against unbound coverage |
| **Law Firm Trust (IOLTA)** | three-way reconciliation, overdrawn client ledgers, unsupported fee transfers, firm funds in trust, dormant balances | A trust account that does not reconcile, one client's money funding another's, fees drawn before billing, commingled firm money, idle balances needing escheat |
| **Excise Tax** | liability vs tax remitted, operations-report rollforward, report vs return, missing or late filings, loss variance | Underpaid returns, product that left without being reported, a report and a return that disagree, missed or late filings, losses over tolerance (a diversion signal) |
| **Property Management & HOA** | broker trust vs liability, overdrawn owner ledgers, tenant deposits held vs owed, overdue deposit returns, HOA reserve transfers without board approval, HOA budget variance, delinquent assessments | A short broker trust account, one beneficiary's money funding another's, tenant deposits not in trust, late deposit returns, reserves spent without approval, overspent HOA lines, aged owner delinquencies |
| **Nonprofit Restricted Funds** | restricted spending outside purpose or window, releases vs qualifying spending, functional-expense tie-out, restricted-cash coverage, Single Audit threshold | Donor-restricted money misspent, a restriction released before the money was used, a functional-expense statement that does not tie, restricted funds spent into operations, federal spending that triggers a Single Audit |
| **School Districts** | student activity negative balances, late or undeposited activity cash, activity disbursements without approval, federal costs outside the award period, budget variance | A club or class account overdrawn, cash held too long before deposit, payments made without the required sign-offs, federal costs outside the period of performance, overspent budget lines |
| **Construction Contracts** | cost-to-cost WIP schedule tied to the GL, billings tied to the balance sheet, loss jobs, margin fade since the last WIP snapshot, retainage reconciliation, subcontractor payments without a lien waiver | A WIP schedule that does not tie to the books, over/underbillings that misstate the balance sheet, a job headed for a loss, an eroding estimate, retainage lost or double counted, a payment released with no lien waiver |

Each pack ships a synthetic demo ledger so the controls run out of the box, and the packs reach none of a ledger's sensitive fields: the municipal demo withholds `payroll` and vendor tax IDs, the insurance demo withholds an `insured_pii` table of SSNs and health notes, the IOLTA demo withholds a `client_contacts` table of client names and addresses, the excise demo withholds a `customer_accounts` table of wholesale-account names and addresses, the property and HOA demos withhold a `resident_pii` table of tenant and owner names, SSNs and bank accounts, the nonprofit demo withholds a `donor_pii` table of donor names, addresses and gift histories, the schools demo withholds a `student_records` table of student names, grade levels and meal-eligibility status under FERPA, and the construction demo withholds a `payroll_pii` table of employee names, SSNs, pay rates and certified-payroll classifications, and the guard refuses any query that reaches them. The excise rate lives in a `tax_rates` table so a rate change is data, not a new ruleset. A PASS is evidence a licensed professional can recompute and confirm against the entity's own obligations, not a certification or an audit opinion.

To run the insurance, IOLTA, excise, property, HOA, nonprofit, schools or construction pack, serve `vanguard-core/assets/insurance/`, `vanguard-core/assets/iolta/`, `vanguard-core/assets/excise/`, `vanguard-core/assets/property/`, `vanguard-core/assets/hoa/`, `vanguard-core/assets/nonprofit/`, `vanguard-core/assets/schools/` or `vanguard-core/assets/construction/` as a custom warehouse with `CIVIC_RULESET_PATH` pointing at its signed ruleset; the agent skill's READMEs for the [Insurance & Fiduciary](skills/civic-chain-auditor/README.md#insurance--fiduciary-pack), [Law Firm Trust (IOLTA)](skills/civic-chain-auditor/README.md#law-firm-trust-iolta-pack), [Excise Tax](skills/civic-chain-auditor/README.md#excise-tax-pack), [Property Management & HOA](skills/civic-chain-auditor/README.md#property-management--hoa-pack), [Nonprofit Restricted Funds](skills/civic-chain-auditor/README.md#nonprofit-restricted-funds-pack), [School Districts](skills/civic-chain-auditor/README.md#school-districts-pack) and [Construction Contracts](skills/civic-chain-auditor/README.md#construction-contracts-pack) packs have the steps.

## Why this matters: Big-Four assurance on a municipal budget

A Big Four audit is deep, skilled work. It is also periodic, sampled, retrospective, and priced for large entities: a firm tests a slice of the transactions, forms a judgment, and issues an opinion you are asked to trust, while the evidence stays in the firm's workpapers. The smaller the government, a town, a school district, a county, the less continuous assurance it can afford, exactly where every dollar is most visible to a resident.

The Civic-Chain Auditor does not replace the auditor. It produces the evidence an audit rests on, and makes it something a resident, a council member, and the auditor can all recompute:

| | Traditional audit engagement | Civic-Chain Auditor |
|---|---|---|
| **Coverage** | A sample of transactions | Every figure in every answer |
| **Cadence** | Annual, quarterly at most | Continuous, on every question |
| **Latency** | Months after the period closes | At the moment you ask |
| **Deliverable** | An opinion you are asked to trust | An evidence packet you can recompute |
| **Tamper evidence** | Held in the firm's workpapers | A hash-chained log anyone can verify |
| **Cost** | A six-figure engagement | Software |

None of the underlying parts are new, guarded text-to-SQL, verification of AI-generated figures, and tamper-evident ledgers all exist on their own. The contribution is binding them so a resident or council member cannot receive an unverified figure, and every answer leaves a reproducible, tamper-evident record. [`COMPARISON.md`](COMPARISON.md) sets this against governed text-to-SQL (Snowflake Cortex Analyst, Databricks Genie), claim verifiers, database ledgers, and generic AI guardrails in detail; [`site/value.html`](site/value.html) is the same case for a municipal reader.

## Quick start

```bash
cd vanguard-core
npm install
npm run seed            # build the demo warehouse
npm test                # 436 tests, no credential required

# Reporting-gap case study (no credential, real 10-K anchors, synthetic rows)
node bin/vanguard.js enron seed
node bin/vanguard.js enron revenue     # reported (gross) vs margin actually earned (net)
node bin/vanguard.js enron debt        # reported debt vs true debt incl. off-balance-sheet entities

# Evidence controls (PASS / EXCEPTION + provenance)
node bin/vanguard.js controls list
node bin/vanguard.js controls run PI1.2-enron-debt-reconciliation

# Verify the tamper-evident audit chain end to end
node bin/vanguard.js audit

# Signed domain rulesets (the query packs: municipal, insurance, iolta, excise, property, hoa, nonprofit, schools, construction)
node bin/vanguard.js ruleset list                  # the bundled municipal ruleset
node bin/vanguard.js ruleset show assets/insurance/ruleset.insurance-v1.json   # signature status + content hash
node bin/vanguard.js ruleset show assets/iolta/ruleset.iolta-v1.json           # the IOLTA pack
node bin/vanguard.js ruleset show assets/excise/ruleset.excise-v1.json         # the Excise Tax pack
node bin/vanguard.js ruleset show assets/property/ruleset.property-trust-v1.json  # the broker-trust pack
node bin/vanguard.js ruleset show assets/hoa/ruleset.hoa-v1.json               # the HOA pack
node bin/vanguard.js ruleset show assets/nonprofit/ruleset.nonprofit-v1.json   # the Nonprofit Restricted Funds pack
node bin/vanguard.js ruleset show assets/schools/ruleset.schools-v1.json       # the School Districts pack
node bin/vanguard.js ruleset show assets/construction/ruleset.construction-v1.json  # the Construction Contracts pack

# Build a guarded warehouse from your own ledger (local only, no credential)
node bin/vanguard.js import spending.csv                      # propose a column mapping, writes nothing
node bin/vanguard.js import spending.csv --map mapping.json   # confirm the mapping and build
node bin/vanguard.js report --warehouse municipal --out report.html   # a shareable evidence report

# Ask in plain English, planning and narration call a model (set the key first)
export ANTHROPIC_API_KEY=...
node bin/vanguard.js ask "your question about the seeded demo data"
```

The guard, the warehouse, the lineage record, and the audit chain all run with no credential; only the plan and narrate steps call the model. **Node 22+ is required** (`node:sqlite` is used).

## What is real, and what is not

In keeping with the project's own discipline about claims:

- **Real:** the guard (table and column allow-lists, a query budget, a row-level scope hook driven by an authenticated principal), read-only enforcement behind a warehouse-connector interface, unit-aware grounding, lineage capture and hashing, the hash-chained audit log with Ed25519 signing, an RFC 9162 Merkle checkpoint and a pluggable external-anchoring hook, a first-class metric registry, the CSV importer (buyer's ledger to a guarded warehouse, each source file recorded by SHA-256), the signed domain rulesets (municipal, insurance, IOLTA, excise, property-trust, HOA, nonprofit, schools and construction) with their automatic integrity and finding checks, the shareable audit report, the CLI, and the offline test suite (436 tests, no credential).
- **Synthetic:** the demo warehouse **values**, generated deterministically so the same question always produces the same result hash. The reporting-gap study's *aggregates* reconcile to real, cited FY2000 10-K figures; its transaction rows and off-balance-sheet amounts are synthetic and labelled. For a tool about traceable figures, fabricated data clearly labelled as fabricated is fine; fabricated data presented as real is the exact failure this project exists to prevent.
- **Not a compliance claim:** audit entries carry tags like `processing-integrity` because the query path is read-only over a schema with no personal data, a true statement about this configuration, not a certification. What this produces is *evidence*: a query, its provenance, a reproducible hash of its result, and a chain showing the record has not been edited since.

## Requirements

Node 22+ (`node:sqlite` is built in, so there is no native database dependency to compile). Planning and narration call a large language model; the API key is read from the environment (see the quick start). The guard, warehouse, grounding, lineage, and audit chain run entirely offline.

## Licence

Source-available under the **Civic-Chain Commercial Licence**; see [`LICENSE`](LICENSE). The right to use is included with a Civic-Chain subscription. The source is published for inspection; this is **not** open source, and it may not be redistributed or resold. Versions published before the licence cut-over (see `CHANGELOG.md`) were offered under MIT and remain available under those terms to anyone who already holds them.

The licence text is a counsel-pending draft (milestone C1); do not rely on it as final.
