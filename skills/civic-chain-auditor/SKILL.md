---
name: civic-chain-auditor
description: Use when the user asks to audit or reconcile a financial ledger and wants figures they can trust and reproduce, in any of these domains: municipal or public grant and budget spending (drawdowns, overruns, vendor breakdowns); an insurance agency's premium trust; a law firm's client trust (IOLTA three-way reconciliation); an excise licensee's filings (beer, alcohol, tobacco or cannabis); a real estate broker's or property manager's trust and an HOA's reserves and assessments; a nonprofit's donor-restricted funds and Single Audit threshold; a school district's student activity funds and federal program costs; or a construction contractor's work-in-progress schedule. Also verifies audit logs and SOC 2 evidence controls. Answers only through the Civic-Chain Auditor MCP server (required): every figure comes from a read-only SQL query checked against the source rows, with a result hash and a tamper-evident audit trail. Ships a synthetic demo ledger per domain.
---

# Civic-Chain Grant & Budget Auditor

Use this skill to audit grant spending, budget variance, fiduciary trust accounts, regulated
filings and audit logs, with every figure traced to source records. It works through the
Civic-Chain Auditor MCP server, which covers several domains, each configured as a **warehouse**
with its own named queries (see **Domain packs** below).

The Civic-Chain Auditor is a query engine built so that no unverified number reaches the user. The
model writes SQL, `guard.js` checks it, a read-only SQLite connection produces the rows,
`grounding.js` checks every figure in the prose against those rows, and `audit.js` hash-chains the
result.

Your job is to keep that guarantee intact on your side of the conversation. **Every figure you
show the user must come from a Civic-Chain Auditor tool result in this conversation.** Do not
estimate, extrapolate, round differently, or do arithmetic on returned figures yourself. If the
number you need isn't in a result, ask the Auditor for it or say it isn't available.

## Setup (once)

Install the engine from npm and let it print the MCP config, then paste the printed `mcpServers`
block into your host and restart it:

```bash
npx @civic-chain/auditor doctor
```

This one install step is required and justified: the skill is instructions only, while the audit
guarantee (the SQL guard, the grounding check, and the hash-chained log) runs in the
`@civic-chain/auditor` engine package. `doctor` fetches that package from the npm registry,
verifies the Node 22+ runtime, builds the bundled municipal demo into a local data directory (no
network beyond the install, no subprocess, no credential read), and prints a ready-to-paste
`mcpServers` block that launches the server with `npx @civic-chain/auditor mcp`.

Needs Node 22+. Full environment variables, custom-ledger setup, and the complete warehouse and
audit-log reference are in **`references/setup.md`**. In the host, tool names carry the server key
as a prefix (e.g. `mcp__civic-chain-auditor__run_canonical`); below they're written bare.

## Tools

| Tool | Args | Credential | Use for |
|---|---|---|---|
| `run_canonical` | `name`, `args` | none | Pre-written queries: the built-in ones, plus a custom warehouse's **named queries** (`<warehouse>/<query>`), which also return automatic checks. **Prefer this.** |
| `run_query` | `sql`, `warehouse` (default `"saas"`), `question` | none | SQL **you** write for an open-ended question when no API key is configured. Guarded (SELECT-only, allow-list), run read-only, audited, with provenance. |
| `verify_answer` | `sql`, `warehouse`, `claimedResultHash` or `claimedFigure` | none | Re-run SQL behind a figure and confirm it reproduces. Checks a number without trusting any narration. Read-only. |
| `execute_financial_query` | `question`, `warehouse` (default `"saas"`) | API key | Free-text questions on any warehouse with `freeText: true` |
| `list_controls` / `run_control` | `id` (for run) | none | SOC 2 reconciliations with PASS / EXCEPTION and provenance |
| `verify_audit` | `warehouse` | none | Hash-chain integrity check on one audit log (named by warehouse, never by file path) |

Read the resource `civic-chain://warehouses` once per session to see which warehouses are
connected, which accept free text, and (for custom warehouses) what named queries they expose with
their parameters. Built-in canonical queries and the full catalog are in `references/setup.md`.

Only pass the business arguments a query documents. Never pass `dbPath`, `logPath`, `signer` or
`warehouse` inside `args`: the server refuses them, because they would redirect the query or its
audit trail.

## Workflow

### 1. Route the question

- **The question matches a domain pack whose warehouse is listed** → use that pack's named query
  with `run_canonical`. **Always try this first.** No credential, fewest tokens, operator-fixed
  definitions, and results come with automatic checks. Several related questions may be answerable
  from one call. Find the pack and its queries in **Domain packs** below.
- **A pack warehouse covers the domain but no named query fits** → if an API key is configured,
  `execute_financial_query` with `warehouse` set to that name. **With no key, write the SQL
  yourself and call `run_query`** (read the schema resource first for the column names); it is
  guarded, audited and verifiable just the same, only the prose narration is yours to write. Then
  `verify_answer` with the same SQL and the figure you quoted to prove it reproduces.
- **The domain's warehouse is not listed** → say plainly the connected instance has no such ledger,
  and point to `scripts/verify-setup.js` to load the demo or the user's own data. Do **not** send
  it to `saas`, and do not answer from general knowledge.
- **The question matches a built-in canonical query or control** → `run_canonical` or `run_control`.
- **Free-text question on `saas`** → `execute_financial_query` with a key, or `run_query` with SQL
  you write when there is none. On `enron`, `markets` or `lseg`, both are refused
  (`warehouse_not_supported`); offer the nearest canonical query or control.

### 2. Phrase the question so SQL does the math

The planner writes one SQL query from your question, so put every figure you'll need into it:

- Ask for the aggregate (total, count, average, ratio, breakdown), not the raw rows.
- If you'll quote a percentage, remaining balance or difference, ask for it explicitly. A figure
  the query didn't return can't be grounded.
- Name the filter the data uses (in the demo, "spent" means `status = 'paid'`, `void` rows never
  count, spending is compared against `amended_cents`).
- Ask one question at a time. Never pull rows and sum, average or difference them yourself; ask the
  Auditor for the figure directly.

### 3. Handle the result

**`execute_financial_query` success** (`ok: true`): `answer` is the grounded prose. If
`fellBack: true`, grounding failed twice and `answer` is a mechanical summary (figures still
exact); tell the user and re-ask so the SQL returns the figure. If `limitInjected: true`, say the
result may be truncated. If `rows` is empty, say nothing matched; an empty result is not zero.

**Named query** (`run_canonical` on `<warehouse>/<query>`): read the result as described in
**Reading a pack result** below.

**Refusal** (`ok: false`) → the system working; see `references/refusals.md`.
**Tool error** (`isError`) → the message lists valid names; correct the call.

### 4. Present the answer in three parts

1. **Grounded answer.** State figures exactly as they appear in `answer` / `rows` / `control`, with
   the unit from the column name (`_cents`, `_usd_millions`). Cents may be shown as dollars (divide
   by 100 exactly), and say you converted. Never introduce a figure not in the result.
2. **Provenance.** Executed SQL (`sql`), tables/columns (`lineage.tables/columns`), row count,
   timestamp. Say the data is synthetic, because every bundled warehouse is; never present demo
   figures as facts about a real entity.
3. **Audit trail.** Result hash (`lineage.resultHash` / `provenance.resultHash`), audit seq
   (`auditSeq`) and entry hash (`auditHash`), each check result for a named query, and whether the
   entry is signed (`signingKeyId`) or hash-chained but unsigned. Show hashes in full, in code
   formatting; don't truncate them.

### 5. Verify the audit chain (on request)

`verify_audit { "warehouse": "<name>" }` checks that warehouse's log and echoes the `logPath`.
Report `ok: true` as **INTACT** with the entry count, `ok: false` as **BROKEN** at `brokenAt` with
`reason` verbatim. It checks the hash chain only, not signatures. The log-to-warehouse map and
signature-check guidance are in `references/setup.md`.

## Reading a pack result

Every pack's named queries carry automatic checks. Read them in this order, and present the result
the same way across all packs:

- **Read `integrity` first.** `integrity: "pass"` → present the figures normally. `integrity:
  "flag"` → **do not present the figures as fact**; show the flagged check's `message` and
  `detail`, say the definition needs fixing by the operator, and don't retry (the same inputs flag
  again). A specific check with `status: "skipped"` or `"error"` could not run; say so rather than
  describing the result as checked.
- **Then read the findings.** Each `checks[]` entry with `severity: "finding"` and `status: "flag"`
  is an audit finding about the ledger, not an error. Report it with its `message` and the
  `detail.rows`. A finding's weight depends on the domain: the pack files label the serious ones
  **EXCEPTION** (e.g. a trust shortfall, an overdrawn client ledger, an unapproved disbursement) and
  the investigative or housekeeping ones **FLAG** (e.g. margin fade, a dormant balance, a late
  deposit). Use that word when you report it.
- **An `empty` check that returns no rows means the control PASSED.** It is the clean case, not "no
  data". Only present an EXCEPTION or FLAG when a row is actually returned. For a `compare` check,
  `pass` means the assertion held; `flag` names the offending rows in `detail.rows`.

## Claim discipline and PII

These rules hold for every pack; the pack files only name the specifics.

- **Claim discipline.** A PASS means a figure was computed one blessed way, its assertion held, and
  its provenance verifies — never that the entity is "compliant" or "certified". These controls
  produce evidence for a licensed professional to confirm against the obligations that apply; they
  are not the statutory audit (bar, TTB, Single Audit, department-of-insurance, etc.). **Every
  bundled dataset is synthetic**; say so, and never present demo figures as facts about a real
  entity.
- **PII is never readable.** Each pack keeps its sensitive data (SSNs, names, contacts, student or
  payroll records) in a table that is **not** on the allow-list, so any query that would read it is
  refused (`table_not_allowed`, or `column_not_allowed` for a withheld column). This is by design
  and the controls need none of it: say the engine does not expose that data, and **do not try to
  reach it another way**. The pack file names the withheld table.
- **Rules are parameters or data, not assertions.** Thresholds, deadlines and rates vary by
  jurisdiction. Where a query takes one as an argument (e.g. `dormant_days`, `return_days`,
  `threshold_cents`, `max_loss_bps`, `fade_bps`), pass the user's governing rule rather than
  treating the default as law. Where a rate or restriction lives in a ledger table, a change to it
  is a data update, never a new ruleset — never hard-code or guess one.

## Domain packs

Each pack is a warehouse with its own named queries and per-result presentation rules. When a
pack's warehouse is configured, route its questions through `run_canonical` and read the result as
in **Reading a pack result** above. Open the pack's reference file for its query table, the exact
checks each query carries, its withheld PII table, and worked example prompts:

| Warehouse(s) | Domain | Reference |
|---|---|---|
| `municipal` | Grants, budgets, vendor payments, drawdowns | `references/packs/municipal.md` |
| `insurance` | Insurance agency premium trust (fiduciary) | `references/packs/insurance.md` |
| `iolta` | Law firm client trust (IOLTA, ABA Rule 1.15) | `references/packs/iolta.md` |
| `excise` | Excise licensee filings (TTB 27 CFR 25 + state) | `references/packs/excise.md` |
| `property`, `hoa` | Broker/manager trust + HOA reserves and budget | `references/packs/property-hoa.md` |
| `nonprofit` | Donor-restricted funds (ASC 958, Single Audit) | `references/packs/nonprofit.md` |
| `schools` | School district activity funds + federal costs | `references/packs/schools.md` |
| `construction` | Contractor WIP schedule (ASC 606) | `references/packs/construction.md` |

## Controls and refusals

- **SOC 2 controls:** catalog and presentation rules in `references/controls.md`. Report PASS /
  EXCEPTION first; an EXCEPTION is a finding, not a retry.
- **Refusals and self-correction:** the full reason table and the retry-once / never-switch-warehouse
  rules are in `references/refusals.md`.

## Example prompts

A few representative prompts; each pack file carries its own full set.

- "For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance." → `municipal/grant-status { "status": "active" }`
- "Which FY2026 budget lines spent more than their amended budget?" → `municipal/budget-variance { "fiscal_year": 2026 }`, then report the `within-amended-budget` finding
- "Is the agency's premium trust account solvent? Include the result hash." → `insurance/trust-account-solvency`, report the `trust-solvent` check first
- "Does our client trust account reconcile three ways as of June 30?" → `iolta/three-way-reconciliation { "as_of": "2026-06-30" }`
- "Is any job headed for a loss?" → `construction/loss-jobs`; an empty result means none
- "Show vendor tax IDs." → refused by policy (`column_not_allowed`); say so.
- "Verify every Civic-Chain Auditor audit log and tell me whether any chain is broken." → `verify_audit` per warehouse

Worked transcripts with real figures and hashes are in `examples/`.
