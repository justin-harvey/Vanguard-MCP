# Civic-Chain Grant & Budget Auditor (agent skill)

**Ask about a budget or a grant and get only figures that were checked against the ledger, each with a hash you can reproduce.**

This skill teaches an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP host) to answer financial questions through the [Civic-Chain Grant & Budget Auditor](https://github.com/justin-harvey/Vanguard-MCP) engine. The agent never does the math. A guarded, read-only SQL query produces every number, a verifier checks every figure in the prose against the returned rows, and each answer is written to a tamper-evident, hash-chained audit log.

## What you get

- **A working demo in about two minutes.** A fictional town's ledger (the Town of Sampleton) with grants, vendors, budget lines, expenditures and grant drawdowns: 108 rows across 8 tables. It has realistic findings built in for the agent to surface: a grant drawn down ahead of its spending, a grant carrying unreimbursed costs, an overspent budget line, and a voided duplicate invoice.
- **An insurance agency demo too.** The Insurance & Fiduciary pack ships a second synthetic ledger (the Harborline Insurance Agency) with a signed `insurance-v1` ruleset of three controls: premium-trust solvency, carrier commission variance, and errors-and-omissions exposure on unbound policies. See [Insurance & Fiduciary pack](#insurance--fiduciary-pack) below.
- **Privacy controls you can see working.** The municipal allow-list withholds a `payroll` table and the vendors' tax IDs and bank details; the insurance allow-list withholds an `insured_pii` table of policyholder SSNs and health notes. You can watch the guard refuse requests for any of them.
- **Automatic checks on every named query.** Integrity checks catch double counting from a bad JOIN before a figure reaches you; finding checks surface overspending, grant cash drawn ahead of spending, a short premium trust, commission variances and unbound premium. For the insurance pack's `empty` checks, a result with no rows is the clean, passing case.
- **Refusal handling.** The agent knows which refusals to fix itself (rephrase once) and which to report (policy-withheld data, write requests), so it doesn't loop or guess.
- **Audit answers.** Every response carries the executed SQL, the tables and columns read, the row count, the result hash and the audit-chain entry. The agent can verify any log's integrity on request.
- **Bring your own ledger.** Point two environment variables at your own SQLite file and allow-list, with no code changes.

## Quick start

Requires **Node.js 22+** and a checkout of the Civic-Chain Grant & Budget Auditor.

```bash
git clone https://github.com/justin-harvey/Vanguard-MCP.git
cd Vanguard-MCP/vanguard-core && npm install && cd -

node path/to/civic-chain-auditor/scripts/verify-setup.js --core Vanguard-MCP/vanguard-core
```

The check prints an `mcpServers` block. Paste it into `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) or `claude_desktop_config.json` (Claude Desktop), add your Anthropic API key, and restart the client. (The API key is optional; see below.) Then try:

> How much of the paving grant (G-402) has been spent so far, broken down by vendor? Include the result hash.

> For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance.

> Which FY2026 budget lines spent more than their amended budget?

> Verify the municipal audit log.

**No API key needed for the demo questions above.** They run as *named queries*: SQL written once in the allow-list file, so the agent picks a query and fills in parameters instead of writing SQL. That uses fewer tokens and gives the same answer every time. Each result comes with automatic checks: integrity (no duplicated rows; the total reconciles against an independent query) and findings (for example an overspent budget line). An Anthropic API key is needed only for open-ended questions that no named query covers.

## Insurance & Fiduciary pack

A second signed domain pack, served as a custom warehouse named `insurance`. All three controls are named queries: no API key, deterministic SQL, and automatic checks.

| Query | Args | Reports | Result |
|---|---|---|---|
| `insurance/trust-account-solvency` | none | Premiums collected, carrier remittances, commission drawn, the net trust liability, and the latest bank balance | **EXCEPTION** (fiduciary trust shortfall) when the bank balance does not cover the liability |
| `insurance/commission-variance-audit` | `min_variance_cents` (optional, default 100) | Active or bound policies whose received commission differs from the contracted rate by more than the threshold | No rows = PASS; any row = **FLAG** |
| `insurance/eo-unbound-exposure` | none | Policies holding client premium with no carrier-confirmed binder | No rows = PASS; any row = **EXCEPTION** (E&O exposure) |

The bundled Harborline data is clean, so all three controls read PASS out of the box. `examples/04-insurance-trust-shortfall.md` shows a shortfall being caught.

**Setup.** `verify-setup.js` builds only the municipal demo, so build the insurance database by hand, then serve it from its own server entry (one custom warehouse per server):

```bash
cd path/to/civic-chain-auditor/assets
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync('sample_insurance_trust.sqlite');db.exec(fs.readFileSync('sample_insurance_trust.sql','utf8'));db.close()"
```

```json
"civic-chain-insurance": {
  "command": "node",
  "args": ["<vanguard-core>/bin/vanguard.js", "mcp"],
  "env": {
    "CIVIC_DB_PATH": "<assets>/sample_insurance_trust.sqlite",
    "CIVIC_ALLOWLIST_PATH": "<assets>/sample_insurance_allowlist.json",
    "CIVIC_RULESET_PATH": "<assets>/ruleset.insurance-v1.json"
  }
}
```

`CIVIC_RULESET_PATH` loads the signed ruleset; its queries replace the allow-list's, and every result reports the signature status (checked against `assets/civic-chain-ruleset-pub.pem`). Then try:

> Is the agency's premium trust account solvent? Include the result hash.

> Were any carrier commissions underpaid by more than $50 on active policies?

> Are we holding any client premium for coverage that isn't bound yet?

> List the SSNs on file for policy P-1001. *(refused: `insured_pii` is not exposed)*

**What a PASS means.** A figure was computed one fixed way, its check held, and its provenance verifies. It is evidence for a licensed professional to confirm against the agency's own obligations, not a department-of-insurance audit, a compliance certification or an E&O coverage opinion. All Harborline data is synthetic.

## What's in the package

```
civic-chain-auditor/
├── SKILL.md                             agent instructions: routing, refusals, presentation
├── README.md                            this file
├── assets/
│   ├── sample_municipal_budget.sql      municipal seed script (the source of truth)
│   ├── sample_allowlist.json            municipal permitted tables and columns, plus planner notes
│   ├── ruleset.municipal-v1.json(.sig)  signed municipal ruleset and its detached signature
│   ├── sample_insurance_trust.sql       insurance seed script (Harborline, synthetic)
│   ├── sample_insurance_allowlist.json  insurance permitted tables and columns (no insured_pii)
│   ├── ruleset.insurance-v1.json(.sig)  signed insurance ruleset and its detached signature
│   └── civic-chain-ruleset-pub.pem      public key the ruleset signatures verify against
├── references/                          setup, controls and refusal reference for the agent
├── examples/                            worked transcripts (01-03 municipal, 04 insurance)
└── scripts/
    └── verify-setup.js                  local setup check and config generator (municipal demo)
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
- One custom warehouse per server: to run the municipal and insurance demos together, add two server entries.
- `verify-setup.js` builds and checks only the municipal demo database; the insurance database is built with the one-liner above.
- Over MCP, `verify_audit` checks the hash chain but not signatures; the `cc-auditor audit` CLI checks both.

## Enterprise & custom deployments

Need read-only adapters for PostgreSQL, Snowflake or BigQuery, SSO / role-based access, or external compliance anchoring (WORM storage, RFC 3161 timestamping)? Contact info@civic-chain.com about Civic-Chain Auditor enterprise and custom deployments.

## Licence

Source-available under the **Civic-Chain Commercial Licence**; see the `LICENSE` file in the Civic-Chain Grant & Budget Auditor repository. The right to use is included with a Civic-Chain subscription. This is not open source, and may not be redistributed or resold.
