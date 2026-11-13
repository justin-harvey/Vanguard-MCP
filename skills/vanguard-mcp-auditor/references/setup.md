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

In the host, tool names carry the server key as a prefix (for example `mcp__vanguard-mcp__execute_financial_query`). In SKILL.md they're written bare.

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

### Built-in canonical queries (`run_canonical`, no credential)

| `name` | `args` | What it answers |
|---|---|---|
| `enron/revenue` | `{ "fiscalYear": 2000 }` | Revenue reported gross vs net margin actually earned (USD millions) |
| `enron/debt` | `{ "fiscalYear": 2000 }` | Reported debt vs total debt including off-balance-sheet entities |
| `markets/net-position` | `{ "ticker": "ACME" }` | Net position per account at close |
| `markets/surveillance` | `{ "windowMs": 2000, "minCancels": 3 }` | Rapid place-and-cancel patterns |
| `saas/mrr` | `{}` | MRR from the movement ledger vs MRR reconstructed from subscriptions |

### Named queries on the municipal demo (`run_canonical`, no credential)

Listed, with their parameters, under `queries` in `vanguard://warehouses`.

| `name` | `args` (all optional) | What it answers |
|---|---|---|
| `municipal/grant-status` | `grant_id`, `status` | Award, paid, pending, drawn down, remaining balance, % spent, per grant |
| `municipal/spending-by-vendor` | `grant_id`, `fiscal_year`, `dept_id` | Paid spending and invoice count per vendor |
| `municipal/budget-variance` | `fiscal_year`, `dept_id` | Adopted vs amended budget, paid, pending, remaining, % used, per line |

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
| `<name>-audit.jsonl` beside the db | custom warehouse, e.g. `municipal` | `{ "warehouse": "municipal" }` |

If the user asks about "the audit log" in general, verify every log that applies. Report:
- `ok: true` → **INTACT**, with the entry count.
- `ok: false` → **BROKEN** at index `brokenAt`, with `reason` verbatim. Entries before that index still verify; that entry and every one after it are suspect.

Over MCP, `verify_audit` checks the hash chain only. It does **not** check Ed25519 signatures. For signature checks, point the user to `node bin/vanguard.js audit` (or `enron audit`, `markets audit`, `lseg audit`) with the signing key configured. For a PASS / EXCEPTION evidence result, call `run_control` with `{ "id": "CC7.2-audit-chain-integrity", "logPath": "<log>" }`. Without `logPath` it checks the markets log only. It returns `provenance: null` because verifying a chain adds no new entry.
