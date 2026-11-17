---
name: civic-chain-auditor
description: Use when the user asks to audit grant spending, check a municipal or public budget, track grant drawdowns against expenditures, find budget overruns or overspent line items, break spending down by vendor, verify an audit log, or get financial figures they can trust and reproduce. Answers through the Civic-Chain Auditor MCP server (required): every number comes from a read-only SQL query checked against the source rows, with a result hash and a tamper-evident audit trail. Also covers SOC 2 evidence controls and ledger reconciliation. Includes a demo town budget ledger.
---

# Civic-Chain Grant & Budget Auditor

Use this skill to audit grant spending, budget variance, vendor payments and drawdowns, and to verify audit logs, with every figure traced to source records. It works through the Civic-Chain Auditor MCP server.

The Civic-Chain Auditor is a query engine built so that no unverified number reaches the user. The model writes SQL, `guard.js` checks it, a read-only SQLite connection produces the rows, `grounding.js` checks every figure in the prose against those rows, and `audit.js` hash-chains the result.

Your job is to keep that guarantee intact on your side of the conversation. **Every figure you show the user must come from a Civic-Chain Auditor tool result in this conversation.** Do not estimate, extrapolate, round differently, or do arithmetic on returned figures yourself. If the number you need isn't in a result, ask the Auditor for it or say it isn't available.

## Setup (once)

Run the bundled check, then paste the printed `mcpServers` block into your host and restart it:

```bash
cd vanguard-core && npm install && cd -
node scripts/verify-setup.js --core /path/to/vanguard-mcp/vanguard-core
```

Needs Node 22+. Full environment variables, custom-ledger setup, and the complete warehouse and audit-log reference are in **`references/setup.md`**. In the host, tool names carry the server key as a prefix (e.g. `mcp__civic-chain-auditor__run_canonical`); below they're written bare.

## Tools

| Tool | Args | Credential | Use for |
|---|---|---|---|
| `run_canonical` | `name`, `args` | none | Pre-written queries: the built-in ones, plus a custom warehouse's **named queries** (`<warehouse>/<query>`), which also return automatic checks. **Prefer this.** |
| `run_query` | `sql`, `warehouse` (default `"saas"`), `question` | none | SQL **you** write for an open-ended question when no API key is configured. Guarded (SELECT-only, allow-list), run read-only, audited, with provenance. |
| `verify_answer` | `sql`, `warehouse`, `claimedResultHash` or `claimedFigure` | none | Re-run SQL behind a figure and confirm it reproduces. Checks a number without trusting any narration. Read-only. |
| `execute_financial_query` | `question`, `warehouse` (default `"saas"`) | API key | Free-text questions on any warehouse with `freeText: true` |
| `list_controls` / `run_control` | `id` (for run) | none | SOC 2 reconciliations with PASS / EXCEPTION and provenance |
| `verify_audit` | `warehouse` | none | Hash-chain integrity check on one audit log (named by warehouse, never by file path) |

Read the resource `civic-chain://warehouses` once per session to see which warehouses are connected, which accept free text, and (for custom warehouses) what named queries they expose with their parameters. The municipal demo exposes `municipal/grant-status`, `municipal/spending-by-vendor` and `municipal/budget-variance`. Built-in canonical queries and the full catalog are in `references/setup.md`.

Only pass the business arguments a query documents. Never pass `dbPath`, `logPath`, `signer` or `warehouse` inside `args`: the server refuses them, because they would redirect the query or its audit trail.

## Workflow

### 1. Route the question

- **Budget, grant, vendor or spending question, and a custom warehouse is listed:**
  - **A named query covers it** → `run_canonical` with that query. **Always try this first.** No credential, fewest tokens, operator-fixed definitions (e.g. "spent means paid, never void"), and results come with automatic checks. Several related questions may be answerable from one call.
  - **No named query covers it** → if an API key is configured, `execute_financial_query` with `warehouse` set to that name. **With no key, write the SQL yourself and call `run_query`** (read the schema resource first for the column names); it is guarded, audited and verifiable just the same, only the prose narration is yours to write. Then `verify_answer` with the same SQL and the figure you quoted to prove it reproduces.
- **Budget or grant question, and no such warehouse is listed** → say plainly the connected instance has no budget or grant ledger, and point to `scripts/verify-setup.js` to load the demo or the user's own data. Do **not** send it to `saas`, and do not answer from general knowledge.
- **The question matches a canonical query or control** → `run_canonical` or `run_control`.
- **Free-text question on `saas`** → `execute_financial_query` with a key, or `run_query` with SQL you write when there is none. On `enron`, `markets` or `lseg`, both are refused (`warehouse_not_supported`); offer the nearest canonical query or control.

### 2. Phrase the question so SQL does the math

The planner writes one SQL query from your question, so put every figure you'll need into it:

- Ask for the aggregate (total, count, average, ratio, breakdown), not the raw rows.
- If you'll quote a percentage, remaining balance or difference, ask for it explicitly. A figure the query didn't return can't be grounded.
- Name the filter the data uses (in the demo, "spent" means `status = 'paid'`, `void` rows never count, spending is compared against `amended_cents`).
- Ask one question at a time. Never pull rows and sum, average or difference them yourself; ask the Auditor for the figure directly.

### 3. Handle the result

**`execute_financial_query` success** (`ok: true`): `answer` is the grounded prose. If `fellBack: true`, grounding failed twice and `answer` is a mechanical summary (figures still exact); tell the user and re-ask so the SQL returns the figure. If `limitInjected: true`, say the result may be truncated. If `rows` is empty, say nothing matched; an empty result is not zero.

**Named query** (`run_canonical` on `<warehouse>/<query>`): read `integrity` **before anything else**.

- `integrity: "pass"` → present it normally.
- `integrity: "flag"` → **do not present the figures as fact.** Show the flagged check's `message` and `detail`, and say the definition needs fixing by the operator. Don't retry; the same inputs will flag again.
- `findings` > 0 → each `checks[]` entry with `severity: "finding"` and `status: "flag"` is an audit finding about the ledger (e.g. an overspent line, or grant cash drawn ahead of spending). Report it with its `message` and the `detail.rows`. It is a property of the data, not an error.
- A check with `status: "skipped"` or `"error"` could not run. Say so; don't describe the result as checked.

**Refusal** (`ok: false`) → the system working; see `references/refusals.md`.
**Tool error** (`isError`) → the message lists valid names; correct the call.

### 4. Present the answer in three parts

1. **Grounded answer.** State figures exactly as they appear in `answer` / `rows` / `control`, with the unit from the column name (`_cents`, `_usd_millions`). Cents may be shown as dollars (divide by 100 exactly), and say you converted. Never introduce a figure not in the result.
2. **Provenance.** Executed SQL (`sql`), tables/columns (`lineage.tables/columns`), row count, timestamp. Say the data is synthetic, because every bundled warehouse is; never present demo figures as facts about a real entity.
3. **Audit trail.** Result hash (`lineage.resultHash` / `provenance.resultHash`), audit seq (`auditSeq`) and entry hash (`auditHash`), each check result for a named query, and whether the entry is signed (`signingKeyId`) or hash-chained but unsigned. Show hashes in full, in code formatting; don't truncate them.

### 5. Verify the audit chain (on request)

`verify_audit { "warehouse": "<name>" }` checks that warehouse's log and echoes the `logPath`. Report `ok: true` as **INTACT** with the entry count, `ok: false` as **BROKEN** at `brokenAt` with `reason` verbatim. It checks the hash chain only, not signatures. The log-to-warehouse map and signature-check guidance are in `references/setup.md`.

## Controls and refusals

- **SOC 2 controls:** catalog and presentation rules in `references/controls.md`. Report PASS / EXCEPTION first; an EXCEPTION is a finding, not a retry.
- **Refusals and self-correction:** the full reason table and the retry-once / never-switch-warehouse rules are in `references/refusals.md`.

## Example prompts

- "How much of the paving grant (G-402) has been spent, broken down by vendor? Include the result hash." → `municipal/spending-by-vendor { "grant_id": "G-402" }`
- "For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance." → `municipal/grant-status { "status": "active" }`
- "Which FY2026 budget lines spent more than their amended budget?" → `municipal/budget-variance { "fiscal_year": 2026 }`, then report the `within-amended-budget` finding
- "Show vendor tax IDs." → refused by policy (`column_not_allowed`); say so.
- "Verify every Civic-Chain Auditor audit log and tell me whether any chain is broken."

Worked transcripts with real figures and hashes are in `examples/`.
