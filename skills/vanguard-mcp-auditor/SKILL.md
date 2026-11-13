---
name: vanguard-mcp-auditor
description: Use when the user asks to audit grant spending, check a municipal or public budget, track grant drawdowns against expenditures, find budget overruns or overspent line items, break spending down by vendor, verify an audit log, or get financial figures they can trust and reproduce. Answers through the Vanguard MCP server (required): every number comes from a read-only SQL query checked against the source rows, with a result hash and a tamper-evident audit trail. Also covers SOC 2 evidence controls and ledger reconciliation. Includes a demo town budget ledger.
---

# Grant & Budget Auditor (Vanguard MCP)

Use this skill to audit grant spending, budget variance, vendor payments and drawdowns, and to verify audit logs, with every figure traced to source records. It works through the Vanguard MCP server.

Vanguard MCP is a query engine built so that no unverified number reaches the user. The model writes SQL, `guard.js` checks it, a read-only SQLite connection produces the rows, `grounding.js` checks every figure in the prose against those rows, and `audit.js` hash-chains the result.

Your job is to keep that guarantee intact on your side of the conversation. **Every figure you show the user must come from a Vanguard tool result in this conversation.** Do not estimate, extrapolate, round differently, or do arithmetic on returned figures yourself. If the number you need isn't in a result, ask Vanguard for it or say it isn't available.

## Setup

Run the bundled check once. It is local-only: no network calls and no subprocesses, and the only file it writes is the demo database in `assets/`.

```bash
cd vanguard-core && npm install && cd -
node scripts/verify-setup.js --core /path/to/vanguard-mcp/vanguard-core
```

The script:
- checks Node 22+
- builds `assets/sample_municipal_budget.sqlite` from the bundled `.sql` seed (the package ships no binaries)
- validates `assets/sample_allowlist.json` against the database
- loads the warehouse through the engine as a smoke test
- prints the exact `mcpServers` JSON to paste into Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`) or Claude Desktop

The printed config has this shape:

```json
{
  "mcpServers": {
    "vanguard-mcp": {
      "command": "/absolute/path/to/node",
      "args": ["/path/to/vanguard-mcp/vanguard-core/bin/vanguard.js", "mcp"],
      "env": {
        "VANGUARD_DB_PATH": "/path/to/assets/sample_municipal_budget.sqlite",
        "VANGUARD_ALLOWLIST_PATH": "/path/to/assets/sample_allowlist.json",
        "ANTHROPIC_API_KEY": "<your-anthropic-api-key>"
      }
    }
  }
}
```

| Variable | Needed for |
|---|---|
| `VANGUARD_DB_PATH` + `VANGUARD_ALLOWLIST_PATH` | Serving a custom warehouse, such as the municipal demo or the user's own ledger. Both or neither. |
| `VANGUARD_AUDIT_LOG` | Optional. Defaults to `<name>-audit.jsonl` beside the database. |
| `ANTHROPIC_API_KEY` | `execute_financial_query` only. Everything else runs without a credential. |
| `VANGUARD_SIGNING_KEY_FILE` (or `VANGUARD_SIGNING_KEY`) | Optional Ed25519 signing of audit entries. |

To use their own ledger, the user points the two paths at their SQLite file and an allow-list in the same format as `assets/sample_allowlist.json`, then re-runs the check with `--db` and `--allowlist`. If the allow-list names a table or column that isn't in the database, the server exits at startup with the problem on stderr.

In the host, tool names carry the server key as a prefix (for example `mcp__vanguard-mcp__execute_financial_query`). Below they're written bare.

## What the server exposes

### Resources (read these first)

| URI | Returns |
|---|---|
| `vanguard://warehouses` | Each warehouse's name, description, `freeText` flag, and allow-listed tables |
| `vanguard://schema/{name}` | Live allow-listed tables, columns and types, plus the metric registry |
| `vanguard://controls` | The SOC 2 control catalog |

### Warehouses

| Warehouse | Free text | What it holds |
|---|---|---|
| `municipal` (when configured) | yes | Fictional Town of Sampleton: grants, drawdowns, budget lines, expenditures, vendors. Synthetic. |
| *(any custom name)* | yes | The user's own ledger, loaded from `VANGUARD_DB_PATH` / `VANGUARD_ALLOWLIST_PATH` |
| `saas` | yes | MRR, retention, LTV:CAC, cohorts. Synthetic. |
| `enron` | no | FY2000 reporting gap: synthetic rows anchored to real 10-K aggregates |
| `markets` | no | Orders, executions, positions, surveillance. Synthetic. |
| `lseg` | no | Fundamentals by `TR.*` field code: real RICs and codes, synthetic values |

### Tools

| Tool | Args | Credential | Use for |
|---|---|---|---|
| `execute_financial_query` | `question`, `warehouse` (default `"saas"`) | API key | Free-text questions on any warehouse with `freeText: true` |
| `run_canonical` | `name`, `args` | none | Fixed, pre-written queries on the built-in warehouses |
| `list_controls` | none | none | The SOC 2 control catalog |
| `run_control` | `id` | none | PASS / EXCEPTION reconciliations with provenance |
| `verify_audit` | `warehouse` or `logPath` | none | Hash-chain integrity check on one audit log |

Canonical queries (`run_canonical`):

| `name` | `args` | What it answers |
|---|---|---|
| `enron/revenue` | `{ "fiscalYear": 2000 }` | Revenue reported gross vs net margin actually earned (USD millions) |
| `enron/debt` | `{ "fiscalYear": 2000 }` | Reported debt vs total debt including off-balance-sheet entities |
| `markets/net-position` | `{ "ticker": "ACME" }` | Net position per account at close |
| `markets/surveillance` | `{ "windowMs": 2000, "minCancels": 3 }` | Rapid place-and-cancel patterns |
| `saas/mrr` | `{}` | MRR from the movement ledger vs MRR reconstructed from subscriptions |

Only pass the business arguments shown. Never pass `dbPath`, `logPath`, `signer` or `warehouse` inside `args`: they would redirect the query or its audit trail.

## Workflow

### 1. Route the question

Read `vanguard://warehouses` once per session, then pick the route:

- **Budget, grant, vendor or spending question, and a municipal or custom warehouse is listed** → `execute_financial_query` with `warehouse` set to that name. Read its schema resource first if you don't know the column names.
- **Budget or grant question, and no such warehouse is listed** → say plainly that the connected Vanguard instance has no budget or grant ledger. Point to `scripts/verify-setup.js` to load the demo or the user's own data. Do **not** send the question to `saas` to see what comes back, and do not answer from general knowledge.
- **The question matches a canonical query or control** → `run_canonical` or `run_control`. These are deterministic and need no credential, so prefer them where they fit.
- **Free-text question on `saas`** → `execute_financial_query`.
- **Free-text question on `enron`, `markets` or `lseg`** → offer the nearest canonical query or control. Free text there is refused (`warehouse_not_supported`).

### 2. Phrase the question so SQL does the math

The planner writes one SQL query from your question, so put every figure you'll need into the question:

- Ask for the aggregate (total, count, average, ratio, breakdown), not the raw rows.
- If you'll quote a percentage, remaining balance or difference, ask for it explicitly ("…and the percentage of the award spent, rounded to one decimal"). A figure the query didn't return can't be grounded.
- Name the filter when the data has one. In the municipal demo, "spent" means `status = 'paid'`, and `void` rows are never counted. Spending is compared against `amended_cents`.
- Ask one question at a time.

Do not pull rows and then sum, average or difference them yourself. If the user wants a figure Vanguard didn't return, run another question that asks for it directly.

### 3. Handle the result

**Success** (`ok: true` from `execute_financial_query`):

- `answer` is the grounded prose. `grounded: true` and `verifiedFigures` say how many figures were checked.
- If `fellBack: true`, the model's prose failed grounding twice and `answer` is a plain mechanical summary of the rows. The figures are still exact. Tell the user, and if they need a specific figure, re-ask so that the SQL returns it as a column.
- If `limitInjected: true`, the guard added `LIMIT 1000`. Say the result may be truncated.
- If `rows` is empty, say there is no matching data. An empty result is not zero.

**Refusal** (`ok: false`): this is the system working. See "Refusals and self-correction" below.

**Tool error** (`isError`): for example an unknown canonical name, control id or warehouse. The message lists the valid names; correct the call.

### 4. Present the answer in three parts

**Grounded answer.** For `execute_financial_query`, use `answer`. For `run_canonical` / `run_control`, state the figures exactly as they appear in `rows` / `control`, with the unit taken from the column name (`_cents`, `_usd_millions`). Cents may be shown as dollars (divide by 100 exactly, no further rounding), and you should say you converted them. Never introduce a figure that isn't in the result.

**Provenance.**
- Executed SQL (`sql`), tables and columns (`lineage.tables`, `lineage.columns`), row count (`lineage.rowCount`), and timestamp (`lineage.at`).
- Say when the data is synthetic. Every bundled warehouse is: the municipal demo is a fictional town, enron has synthetic rows anchored to real 10-K aggregates, and lseg uses real identifiers with synthetic values. Never present demo figures as facts about a real entity.

**Audit trail.**
- **Result hash** (`lineage.resultHash` or `provenance.resultHash`): re-running the same SQL against the same snapshot must produce the same hash.
- **Audit entry**: seq (`auditSeq`) and entry hash (`auditHash`).
- **Signature**: say whether the entry is signed (`signed` / `provenance.signature`) and give `signingKeyId` if it is. If it isn't, say it is hash-chained but unsigned.

Show hashes in full, in code formatting. Don't truncate them.

### 5. Verify the audit chain (on request)

Pass `verify_audit` a `warehouse` and it checks that warehouse's log. The result echoes the `logPath` it checked.

| Log | Written by | Verify with |
|---|---|---|
| `db/audit.jsonl` | `execute_financial_query` on `saas` | `verify_audit {}` (the default) |
| `db/saas-audit.jsonl` | `saas/mrr`, saas controls | `{ "warehouse": "saas" }` |
| `db/enron-audit.jsonl` | enron queries and controls | `{ "warehouse": "enron" }` |
| `db/markets-audit.jsonl` | markets queries and controls | `{ "warehouse": "markets" }` |
| `db/lseg-audit.jsonl` | lseg controls | `{ "warehouse": "lseg" }` |
| `<name>-audit.jsonl` beside the db | custom warehouse, e.g. `municipal` | `{ "warehouse": "municipal" }` |

If the user asks about "the audit log" in general, verify every log that applies. Report:
- `ok: true` → **INTACT**, with the entry count.
- `ok: false` → **BROKEN** at index `brokenAt`, with `reason` verbatim. Entries before that index still verify; that entry and every one after it are suspect.

Over MCP, `verify_audit` checks the hash chain only. It does **not** check Ed25519 signatures. For signature checks, point the user to `node bin/vanguard.js audit` (or `enron audit`, `markets audit`, `lseg audit`) with the signing key configured. For a PASS / EXCEPTION evidence result, call `run_control` with `{ "id": "CC7.2-audit-chain-integrity", "logPath": "<log>" }`. Without `logPath` it checks the markets log only. It returns `provenance: null` because verifying a chain adds no new entry.

## Refusals and self-correction

A refusal returns `stage`, `reason`, `message`, and usually `proposedSql`. You can't edit the SQL. Vanguard has no raw-SQL tool, by design. You can only ask again with a better question. Fix it yourself where the table below says to retry, **once**. If the retry is also refused, stop and report both refusals to the user.

| `reason` | Likely cause | What to do |
|---|---|---|
| `column_not_allowed` | The planner reached for a withheld column | If the user didn't ask for that column, **retry** and name the permitted columns from `vanguard://schema/{name}`. If they did ask for it (such as a vendor tax ID), **stop**: tell them the field is withheld by policy, and don't try to infer it another way. |
| `table_not_allowed` | The query read or JOINed a table outside the allow-list | Same rule as above. JOINs between allow-listed tables are fine; only the non-listed table is the problem. If the user asked about that table (`payroll` in the demo), **stop** and say it isn't exposed. |
| `wildcard_not_allowed` | `SELECT *` under a column allow-list | **Retry**, naming the specific fields you need. |
| `unparseable` / `empty` / `no_tables` | The planner produced bad or no SQL | **Retry** with a more concrete question that names the table, the measure and the filter. |
| `multiple_statements` | The question bundled several asks | **Retry** as separate questions, one call each. |
| `timeout` (`stage: execute`) | Query exceeded the time budget | **Retry** narrower: aggregate, filter by year, grant or department. |
| `database_rejected` (`stage: execute`) | Guard passed it, SQLite refused it (bad column reference, type issue) | **Retry** once with exact column names from the schema resource. |
| `not_a_select` / `write_operation` | The question asked to change data | **Stop**. Vanguard is read-only, so say it can't change records. |
| `bad_scope` | Row-level scope could not be applied | **Stop** and report it. Don't route around it. |
| `warehouse_not_supported` (`stage: route`) | Free text on a canonical-only warehouse, or an unknown name | **Reroute** to `run_canonical` / `run_control` if one fits; otherwise tell the user what that warehouse supports. |

Never switch warehouses to get an answer the right warehouse refused, and never answer from memory after a refusal.

### Things that look like refusals but aren't

- **No LIMIT clause.** This is never refused. The guard adds `LIMIT 1000` and sets `limitInjected: true`.
- **A rounded figure.** Grounding accepts rounding to half a unit in the last place written ("36.7%" matches 0.3672), as well as cents shown as dollars and a ratio shown as a percent or basis points. A figure fails only when no returned value supports it, typically a percentage or difference the SQL never computed. Then the narrator retries once and, if it still fails, falls back to the mechanical summary (`fellBack: true`). The fix is to re-ask with the figure requested explicitly, so the SQL returns it.
- **An empty result.** `ok: true` with no rows means nothing matched the filter. Check that the filter values are right (for example `'G-402'`, not `402`) before you report "none".

## Controls

Run `list_controls` for the live list. At the time of writing:

| id | Checks |
|---|---|
| `PI1.1-enron-revenue-reconciliation` | Revenue recognised on the correct basis |
| `PI1.2-enron-debt-reconciliation` | Reported debt reconciles to source records |
| `PI1.2-saas-mrr-reconciliation` | MRR reconciles across independent sources |
| `PI1.2-markets-position-reconciliation` | Derived positions reconcile to the recorded book |
| `PI1.1-lseg-gross-profit-reconciliation` | Gross Profit = Revenue − Cost of Revenue |
| `PI1.1-lseg-standardized-vs-as-reported` | Vendor-standardized figure reconciles to the filing |
| `C1.1-lseg-data-retention` | Cached vendor data is retained within its licensed window |
| `CC7.3-figure-reproducibility` | A past figure reproduces exactly |
| `CC7.2-audit-chain-integrity` | The audit trail is tamper-evident and intact |

Custom warehouses have no controls yet. Do reconciliations there with free-text questions that return both sides, plus the difference, in one query.

Report the control's PASS / EXCEPTION status first, then its figures and provenance. An EXCEPTION is a finding to report clearly. It isn't a failure to retry. SOC 2 criterion tags describe what a check is evidence for. They are not a certification, so don't describe them as one.

## Example prompts

- "How much of the paving grant (G-402) has been spent so far, broken down by vendor? Include the result hash."
- "For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance."
- "Which FY2026 budget lines spent more than their amended budget, and by how much?"
- "Show vendor tax IDs." → refused by policy; say so.
- "Is Enron's FY2000 reported debt consistent with the total once off-balance-sheet entities are included?"
- "Run the MRR reconciliation control and tell me whether it passed."
- "Verify every Vanguard audit log and tell me whether any chain is broken."

## Enterprise & custom deployments

Mention this only when the user asks about production databases, scale, SSO, or anchoring the log externally. Don't bring it up otherwise.

The open-source engine serves local SQLite files. Read-only adapters for PostgreSQL, Snowflake or BigQuery, SSO / role-based access, and external anchoring of the audit log (WORM storage, RFC 3161 timestamping) are available as custom deployments: contact [CONTACT_EMAIL_OR_URL].
