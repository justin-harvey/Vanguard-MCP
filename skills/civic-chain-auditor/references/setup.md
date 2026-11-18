# Setup and configuration

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
    "civic-chain-auditor": {
      "command": "/absolute/path/to/node",
      "args": ["/path/to/vanguard-mcp/vanguard-core/bin/vanguard.js", "mcp"],
      "env": {
        "CIVIC_DB_PATH": "/path/to/assets/sample_municipal_budget.sqlite",
        "CIVIC_ALLOWLIST_PATH": "/path/to/assets/sample_allowlist.json",
        "ANTHROPIC_API_KEY": "<your-anthropic-api-key>"
      }
    }
  }
}
```

| Variable | Needed for |
|---|---|
| `CIVIC_DB_PATH` + `CIVIC_ALLOWLIST_PATH` | Serving a custom warehouse, such as the municipal demo or the user's own ledger. Both or neither. |
| `CIVIC_RULESET_PATH` | Optional. Points at a signed Civic-Chain ruleset (e.g. the insurance pack's `ruleset.insurance-v1.json`); its named queries replace the allow-list's, and every result reports the ruleset's signature status. |
| `CIVIC_AUDIT_LOG` | Optional. Defaults to `<name>-audit.jsonl` beside the database. |
| `ANTHROPIC_API_KEY` | `execute_financial_query` only. Everything else runs without a credential. |
| `CIVIC_SIGNING_KEY_FILE` (or `CIVIC_SIGNING_KEY`) | Optional Ed25519 signing of audit entries. |

The former `VANGUARD_*` names are still read as a fallback for one release.

To use their own ledger, the user points the two paths at their SQLite file and an allow-list in the same format as `assets/sample_allowlist.json`, then re-runs the check with `--db` and `--allowlist`. If the allow-list names a table or column that isn't in the database, the server exits at startup with the problem on stderr.

In the host, tool names carry the server key as a prefix (for example `mcp__civic-chain-auditor__execute_financial_query`). In SKILL.md they're written bare.

## What the server exposes

### Resources (read these first)

| URI | Returns |
|---|---|
| `civic-chain://warehouses` | Each warehouse's name, description, `freeText` flag, and allow-listed tables |
| `civic-chain://schema/{name}` | Live allow-listed tables, columns and types, plus the metric registry |
| `civic-chain://controls` | The SOC 2 control catalog |

### Warehouses

| Warehouse | Free text | What it holds |
|---|---|---|
| `municipal` (when configured) | yes | Fictional Town of Sampleton: grants, drawdowns, budget lines, expenditures, vendors. Synthetic. |
| `insurance` (when configured) | yes | Fictional Harborline Insurance Agency: premium trust ledger, policies, commission receipts, carrier binders, bank snapshots. Synthetic. Served with the signed `insurance-v1` ruleset. |
| `iolta` (when configured) | yes | Fictional Northfield Law Group: client trust (IOLTA) journal, bank reconciliations, fee invoices. Synthetic; clients and matters by ID only. Served with the signed `iolta-v1` ruleset. |
| `excise` (when configured) | yes | Fictional Penobscot Bay Brewing Co.: beer excise rate schedule, taxable removals, operations reports, excise returns. Synthetic; volumes and money by period only. Served with the signed `excise-v1` ruleset. |
| `property` (when configured) | yes | Fictional Sunset Key Realty & Property Management: broker trust ledger (owner funds and tenant deposits), bank snapshots, leases. Synthetic; parties by ledger, property and lease ID only. Served with the signed `property-trust-v1` ruleset. |
| `hoa` (when configured) | yes | Fictional Palm Grove Community Association: reserve transfers, operating budget lines, operating expenses, owner assessments. Synthetic; owners by unit ID only. Served with the signed `hoa-v1` ruleset. |
| *(any custom name)* | yes | The user's own ledger, loaded from `CIVIC_DB_PATH` / `CIVIC_ALLOWLIST_PATH` |
| `saas` | yes | MRR, retention, LTV:CAC, cohorts. Synthetic. |
| `enron` | no | FY2000 reporting gap: synthetic rows anchored to real 10-K aggregates |
| `markets` | no | Orders, executions, positions, surveillance. Synthetic. |
| `lseg` | no | Fundamentals by `TR.*` field code: real RICs and codes, synthetic values |

### Built-in canonical queries (`run_canonical`, no credential)

| `name` | `args` | What it answers |
|---|---|---|
| `enron/revenue` | `{ "fiscalYear": 2000 }` | Revenue reported gross vs net margin actually earned (USD millions) |
| `enron/debt` | `{ "fiscalYear": 2000 }` | Reported debt vs total debt including off-balance-sheet entities |
| `markets/net-position` | `{ "ticker": "ACME" }` | Net position per account at close |
| `markets/surveillance` | `{ "windowMs": 2000, "minCancels": 3 }` | Rapid place-and-cancel patterns |
| `saas/mrr` | `{}` | MRR from the movement ledger vs MRR reconstructed from subscriptions |

### Named queries on the municipal demo (`run_canonical`, no credential)

Listed, with their parameters, under `queries` in `civic-chain://warehouses`.

| `name` | `args` (all optional) | What it answers |
|---|---|---|
| `municipal/grant-status` | `grant_id`, `status` | Award, paid, pending, drawn down, remaining balance, % spent, per grant |
| `municipal/spending-by-vendor` | `grant_id`, `fiscal_year`, `dept_id` | Paid spending and invoice count per vendor |
| `municipal/budget-variance` | `fiscal_year`, `dept_id` | Adopted vs amended budget, paid, pending, remaining, % used, per line |

### Named queries on the insurance demo (`run_canonical`, no credential)

Served by the signed `insurance-v1` ruleset. Presentation rules (PASS / EXCEPTION / FLAG, and the PII refusal) are in SKILL.md under "Insurance & Fiduciary pack".

| `name` | `args` | What it answers |
|---|---|---|
| `insurance/trust-account-solvency` | none | Premiums collected, carrier remittances, commission drawn, net trust liability, latest bank balance; finding when the balance does not cover the liability |
| `insurance/commission-variance-audit` | `min_variance_cents` (optional, default 100) | Active or bound policies whose received commission varies materially from the contracted rate |
| `insurance/eo-unbound-exposure` | none | Policies holding client premium with no carrier-confirmed binder |

### Named queries on the IOLTA demo (`run_canonical`, no credential)

Served by the signed `iolta-v1` ruleset. Presentation rules (PASS / EXCEPTION / FLAG, and the client-PII refusal) are in SKILL.md under "Law Firm Trust (IOLTA) pack".

| `name` | `args` | What it answers |
|---|---|---|
| `iolta/three-way-reconciliation` | `as_of` (optional) | Adjusted bank balance, trust journal balance and the sum of client ledgers; findings when the three do not tie |
| `iolta/negative-client-balances` | `as_of` (optional) | Client ledgers overdrawn below zero (one client's money funding another's) |
| `iolta/unsupported-fee-transfers` | none | Earned-fee transfers out of trust with no invoice, or larger than the invoice |
| `iolta/firm-funds-in-trust` | `max_firm_cents` (optional, default 25000) | Firm money held in trust above the bank-charge allowance (commingling) |
| `iolta/dormant-balances` | `dormant_days` (optional, default 365) | Positive client balances idle past the threshold |

### Named queries on the excise demo (`run_canonical`, no credential)

Served by the signed `excise-v1` ruleset. Presentation rules (PASS / FLAG, the rate-as-data rule and the customer-data refusal) are in SKILL.md under "Excise Tax pack".

| `name` | `args` | What it answers |
|---|---|---|
| `excise/liability-vs-remitted` | `period` (optional, YYYY-MM) | Per period: taxable barrels, the per-barrel rate in force, the expected tax and the tax paid; finding when the tax paid is less than the expected tax |
| `excise/inventory-rollforward` | `period` (optional) | Per period: opening + produced − removed − losses against the reported closing barrels; finding when they do not tie |
| `excise/report-vs-return` | `period` (optional) | Per period: barrels removed on the operations report against barrels reported on the return; finding when they disagree |
| `excise/missing-or-late-filings` | none | Periods with activity but no return, or a return filed after its due date |
| `excise/loss-variance` | `max_loss_bps` (optional, default 300) | Periods whose losses, in basis points of production, exceed the tolerance |

### Named queries on the property demo (`run_canonical`, no credential)

Served by the signed `property-trust-v1` ruleset. Presentation rules (PASS / FLAG, the parameter-as-data rule and the resident-PII refusal) are in SKILL.md under "Property Management & HOA pack".

| `name` | `args` | What it answers |
|---|---|---|
| `property/trust-vs-liability` | `as_of` (optional, YYYY-MM-DD) | Reconciled bank balance against the itemized trust liability (the sum of every beneficiary ledger); finding when the bank balance is short |
| `property/negative-owner-balances` | `as_of` (optional) | Owner ledgers overdrawn below zero (one beneficiary's money funding another's) |
| `property/deposits-held-vs-owed` | `as_of` (optional) | Active leases whose security deposit is not held in trust in full |
| `property/deposit-return-overdue` | `return_days` (optional, default 30) | Ended leases whose deposit is unreturned past the state's deadline |

### Named queries on the HOA demo (`run_canonical`, no credential)

Served by the signed `hoa-v1` ruleset. Presentation rules (PASS / FLAG and the resident-PII refusal) are in SKILL.md under "Property Management & HOA pack".

| `name` | `args` | What it answers |
|---|---|---|
| `hoa/reserve-transfers-unapproved` | none | Transfers out of the reserve account with no board approval on record |
| `hoa/budget-variance` | `fiscal_year` (optional) | Adopted budget, spending and remaining per operating line; finding when a line is over budget |
| `hoa/delinquent-assessments` | `days_past_due` (optional, default 60) | Unpaid owner assessments aged past the threshold |

Only pass the business arguments shown. Never pass `dbPath`, `logPath`, `signer` or `warehouse` inside `args`: the server refuses them, because they would otherwise redirect the query or its audit trail.

## Audit logs and verification

Pass `verify_audit` a `warehouse` and it checks that warehouse's log. The result echoes the `logPath` it checked.

| Log | Written by | Verify with |
|---|---|---|
| `db/audit.jsonl` | `execute_financial_query` on `saas` | `verify_audit {}` (the default) |
| `db/saas-audit.jsonl` | `saas/mrr`, saas controls | `{ "warehouse": "saas" }` |
| `db/enron-audit.jsonl` | enron queries and controls | `{ "warehouse": "enron" }` |
| `db/markets-audit.jsonl` | markets queries and controls | `{ "warehouse": "markets" }` |
| `db/lseg-audit.jsonl` | lseg controls | `{ "warehouse": "lseg" }` |
| `<name>-audit.jsonl` beside the db | custom warehouse, e.g. `municipal`, `insurance`, `iolta`, `excise`, `property` or `hoa` | `{ "warehouse": "municipal" }` / `{ "warehouse": "insurance" }` / `{ "warehouse": "iolta" }` / `{ "warehouse": "excise" }` / `{ "warehouse": "property" }` / `{ "warehouse": "hoa" }` |

If the user asks about "the audit log" in general, verify every log that applies. Report:
- `ok: true` → **INTACT**, with the entry count.
- `ok: false` → **BROKEN** at index `brokenAt`, with `reason` verbatim. Entries before that index still verify; that entry and every one after it are suspect.

Over MCP, `verify_audit` checks the hash chain only. It does **not** check Ed25519 signatures. For signature checks, point the user to `node bin/vanguard.js audit` (or `enron audit`, `markets audit`, `lseg audit`) with the signing key configured. For a PASS / EXCEPTION evidence result, call `run_control` with `{ "id": "CC7.2-audit-chain-integrity" }`, which checks the markets log. Over MCP neither tool accepts a caller `logPath`: the log is chosen on the server, so a tool call cannot point the engine at an arbitrary file. It returns `provenance: null` because verifying a chain adds no new entry.
