# Vanguard MCP Auditor

**Ask about a budget or a grant and get only figures that were checked against the ledger, each with a hash you can reproduce.**

This skill teaches an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP host) to answer financial questions through [Vanguard MCP](https://github.com/justin-harvey/Vanguard-MCP). The agent never does the math. A guarded, read-only SQL query produces every number, a verifier checks every figure in the prose against the returned rows, and each answer is written to a tamper-evident, hash-chained audit log.

## What you get

- **A working demo in about two minutes.** A fictional town's ledger (the Town of Sampleton) with grants, vendors, budget lines, expenditures and grant drawdowns: 108 rows across 8 tables. It has realistic findings built in for the agent to surface: a grant drawn down ahead of its spending, a grant carrying unreimbursed costs, an overspent budget line, and a voided duplicate invoice.
- **Privacy controls you can see working.** The allow-list withholds a `payroll` table and the vendors' tax IDs and bank details, so you can watch the guard refuse requests for them.
- **Automatic checks on every named query.** Integrity checks catch double counting from a bad JOIN before a figure reaches you; finding checks surface overspending and grant cash drawn ahead of spending.
- **Refusal handling.** The agent knows which refusals to fix itself (rephrase once) and which to report (policy-withheld data, write requests), so it doesn't loop or guess.
- **Audit answers.** Every response carries the executed SQL, the tables and columns read, the row count, the result hash and the audit-chain entry. The agent can verify any log's integrity on request.
- **Bring your own ledger.** Point two environment variables at your own SQLite file and allow-list, with no code changes.

## Quick start

Requires **Node.js 22+** and a checkout of Vanguard MCP.

```bash
git clone https://github.com/justin-harvey/Vanguard-MCP.git
cd Vanguard-MCP/vanguard-core && npm install && cd -

node path/to/vanguard-mcp-auditor/scripts/verify-setup.js --core Vanguard-MCP/vanguard-core
```

The check prints an `mcpServers` block. Paste it into `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) or `claude_desktop_config.json` (Claude Desktop), add your Anthropic API key, and restart the client. (The API key is optional; see below.) Then try:

> How much of the paving grant (G-402) has been spent so far, broken down by vendor? Include the result hash.

> For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance.

> Which FY2026 budget lines spent more than their amended budget?

> Verify the municipal audit log.

**No API key needed for the demo questions above.** They run as *named queries*: SQL written once in the allow-list file, so the agent picks a query and fills in parameters instead of writing SQL. That uses fewer tokens and gives the same answer every time. Each result comes with automatic checks: integrity (no duplicated rows; the total reconciles against an independent query) and findings (for example an overspent budget line). An Anthropic API key is needed only for open-ended questions that no named query covers.

## What's in the package

```
vanguard-mcp-auditor/
├── SKILL.md                             agent instructions: routing, refusals, presentation
├── README.md                            this file
├── assets/
│   ├── sample_municipal_budget.sql      readable seed script (the source of truth)
│   └── sample_allowlist.json            permitted tables and columns, plus planner notes
└── scripts/
    └── verify-setup.js                  local setup check and config generator
```

## Using your own data

1. Export or build your ledger as a SQLite file.
2. Copy `assets/sample_allowlist.json` and edit it. List only the tables and columns the agent may read, and add `notes` explaining conventions such as units, fiscal year and status codes.
3. Run `node scripts/verify-setup.js --db your.sqlite --allowlist your_allowlist.json` and paste the printed config.

Anything left out of the allow-list is refused by the engine's guard, which parses every query and checks every table and column it touches, including those in JOINs, subqueries and CTEs. The database is always opened read-only.

## Security and transparency

- The package is text only. The demo database is built on your machine from the plain-text `.sql` seed, so you can read every row before it exists.
- `verify-setup.js` is a single readable file with no dependencies. It makes no network requests, spawns no processes and never reads your credentials or environment secrets. The only file it writes is the demo `.sqlite` in `assets/`.
- All bundled data is synthetic. Sampleton is not a real town, and its vendors, tax IDs and figures are invented.
- The audit log is *tamper-evident*, not immutable: an edit is detectable, not impossible. Entries can be signed with Ed25519 if you set a signing key.

## Limits

- Open-ended (free-text) questions need an Anthropic API key, and each costs one planning call and up to two narration calls. Named queries need neither.
- Custom warehouses support free-text questions; pre-built controls exist only for the bundled demo warehouses.
- Over MCP, `verify_audit` checks the hash chain but not signatures; the `vanguard audit` CLI checks both.

## Enterprise & custom deployments

Need read-only adapters for PostgreSQL, Snowflake or BigQuery, SSO / role-based access, or external compliance anchoring (WORM storage, RFC 3161 timestamping)? Contact [CONTACT_EMAIL_OR_URL] about Vanguard enterprise and custom deployments.

## License

MIT, same as Vanguard MCP.
