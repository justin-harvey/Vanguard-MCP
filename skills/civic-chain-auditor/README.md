# Civic-Chain Grant & Budget Auditor (agent skill)

**Ask about a budget or a grant and get only figures that were checked against the ledger, each with a hash you can reproduce.**

This skill teaches an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP host) to answer financial questions through the [Civic-Chain Grant & Budget Auditor](https://github.com/justin-harvey/Vanguard-MCP) engine. The agent never does the math. A guarded, read-only SQL query produces every number, a verifier checks every figure in the prose against the returned rows, and each answer is written to a tamper-evident, hash-chained audit log.

## What you get

- **A working demo in about two minutes.** A fictional town's ledger (the Town of Sampleton) with grants, vendors, budget lines, expenditures and grant drawdowns: 108 rows across 8 tables. It has realistic findings built in for the agent to surface: a grant drawn down ahead of its spending, a grant carrying unreimbursed costs, an overspent budget line, and a voided duplicate invoice.
- **An insurance agency demo too.** The Insurance & Fiduciary pack ships a second synthetic ledger (the Harborline Insurance Agency) with a signed `insurance-v1` ruleset of three controls: premium-trust solvency, carrier commission variance, and errors-and-omissions exposure on unbound policies. See [Insurance & Fiduciary pack](#insurance--fiduciary-pack) below.
- **A law-firm trust-account demo too.** The Law Firm Trust (IOLTA) pack ships a third synthetic ledger (the Northfield Law Group) with a signed `iolta-v1` ruleset of five controls: three-way reconciliation, overdrawn client ledgers, unsupported fee transfers, firm money commingled in trust, and dormant balances. See [Law Firm Trust (IOLTA) pack](#law-firm-trust-iolta-pack) below.
- **An excise-tax demo too.** The Excise Tax pack ships a fourth synthetic ledger (Penobscot Bay Brewing Co., a beer brewery) with a signed `excise-v1` ruleset of five controls: liability versus tax remitted, the operations-report rollforward, report-versus-return tie-out, missing or late filings, and loss variance. The excise rate lives in a `tax_rates` table so a rate change is data, not a new ruleset. See [Excise Tax pack](#excise-tax-pack) below.
- **Privacy controls you can see working.** The municipal allow-list withholds a `payroll` table and the vendors' tax IDs and bank details; the insurance allow-list withholds an `insured_pii` table of policyholder SSNs and health notes; the IOLTA allow-list withholds a `client_contacts` table of client names and addresses; the excise allow-list withholds a `customer_accounts` table of wholesale-account names and addresses. You can watch the guard refuse requests for any of them.
- **Automatic checks on every named query.** Integrity checks catch double counting from a bad JOIN before a figure reaches you; finding checks surface overspending, grant cash drawn ahead of spending, a short premium trust, commission variances, unbound premium, a trust account that does not reconcile, and overdrawn client ledgers. For the `empty` checks, a result with no rows is the clean, passing case.
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

## Law Firm Trust (IOLTA) pack

A third signed domain pack, served as a custom warehouse named `iolta`. It encodes ABA Model Rule 1.15 and common client-trust reconciliation practice. All five controls are named queries: no API key, deterministic SQL, and automatic checks. The ledger identifies clients and matters by ID only.

| Query | Args | Reports | Result |
|---|---|---|---|
| `iolta/three-way-reconciliation` | `as_of` (optional) | Adjusted bank balance, trust journal balance, and the sum of the client ledgers | PASS when all three tie; **reconciliation break** when they do not |
| `iolta/negative-client-balances` | `as_of` (optional) | Client ledgers overdrawn below zero | No rows = PASS; any row = **EXCEPTION** (one client's money funding another's) |
| `iolta/unsupported-fee-transfers` | none | Fee transfers out of trust with no invoice, or larger than the invoice | No rows = PASS; any row = **FLAG** |
| `iolta/firm-funds-in-trust` | `max_firm_cents` (optional, default 25000) | Firm money in trust above the bank-charge allowance | No rows = PASS; any row = **EXCEPTION** (commingling) |
| `iolta/dormant-balances` | `dormant_days` (optional, default 365) | Positive client balances idle past the threshold | No rows = PASS; any row = **FLAG** |

The bundled Northfield data is clean, so all five controls read PASS out of the box. `examples/05-iolta-overdrawn-client-ledger.md` shows an overdrawn ledger being caught.

**Setup.** As with the insurance pack, build the database by hand and serve it from its own server entry (one custom warehouse per server):

```bash
cd path/to/civic-chain-auditor/assets
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync('sample_iolta_trust.sqlite');db.exec(fs.readFileSync('sample_iolta_trust.sql','utf8'));db.close()"
```

```json
"civic-chain-iolta": {
  "command": "node",
  "args": ["<vanguard-core>/bin/vanguard.js", "mcp"],
  "env": {
    "CIVIC_DB_PATH": "<assets>/sample_iolta_trust.sqlite",
    "CIVIC_ALLOWLIST_PATH": "<assets>/sample_iolta_allowlist.json",
    "CIVIC_RULESET_PATH": "<assets>/ruleset.iolta-v1.json"
  }
}
```

Then try:

> Does our client trust account reconcile three ways as of June 30? Include the result hash.

> Is any client's trust ledger overdrawn?

> Did we move any fees out of trust without a matching invoice?

> Which client balances have sat untouched for over 90 days?

> Give me the client names and addresses in the trust ledger. *(refused: `client_contacts` is not exposed)*

**State rules are parameters.** Reconciliation frequency, the dormancy period and the permitted firm buffer vary by state; they are arguments (`as_of`, `dormant_days`, `max_firm_cents`) with documented defaults, not fixed assertions.

**What a PASS means.** A figure was computed one fixed way, its check held, and its provenance verifies. It is evidence for a licensed professional to confirm against the firm's own obligations and its state's trust-account rules, not a bar trust-account audit or a compliance certification. All Northfield data is synthetic.

## Excise Tax pack

A fourth signed domain pack, served as a custom warehouse named `excise`. It reconciles an excise licensee's filings (the demo is a beer brewery) against federal practice (TTB 27 CFR part 25, operations reports under 27 CFR 25.297) and common state excise rules. The buyer is the licensee checking its own returns or a revenue regulator checking a licensee. All five controls are named queries: no API key, deterministic SQL, and automatic checks. The filings identify product by class and period only.

| Query | Args | Reports | Result |
|---|---|---|---|
| `excise/liability-vs-remitted` | `period` (optional, YYYY-MM) | Per period: taxable barrels, the per-barrel rate in force, the expected tax, and the tax paid | PASS when the tax paid covers the liability; **EXCEPTION** (underpaid return) when it does not |
| `excise/inventory-rollforward` | `period` (optional) | Per period: opening + produced − removed − losses against the reported closing barrels | PASS when they tie; **FLAG** (rollforward break) when they do not |
| `excise/report-vs-return` | `period` (optional) | Per period: barrels removed on the operations report against barrels reported on the return | PASS when they agree; **FLAG** when they disagree |
| `excise/missing-or-late-filings` | none | Periods with activity but no return, or a return filed after its due date | No rows = PASS; any row = **FLAG** (missing or late) |
| `excise/loss-variance` | `max_loss_bps` (optional, default 300) | Periods whose losses, in basis points of production, exceed the tolerance | No rows = PASS; any row = **FLAG** (diversion signal) |

The bundled Penobscot Bay data is clean, so all five controls read PASS out of the box. `examples/06-excise-underpaid-return.md` shows an underpaid return being caught.

**Setup.** As with the insurance and IOLTA packs, build the database by hand and serve it from its own server entry (one custom warehouse per server):

```bash
cd path/to/civic-chain-auditor/assets
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const db=new DatabaseSync('sample_excise_filings.sqlite');db.exec(fs.readFileSync('sample_excise_filings.sql','utf8'));db.close()"
```

```json
"civic-chain-excise": {
  "command": "node",
  "args": ["<vanguard-core>/bin/vanguard.js", "mcp"],
  "env": {
    "CIVIC_DB_PATH": "<assets>/sample_excise_filings.sqlite",
    "CIVIC_ALLOWLIST_PATH": "<assets>/sample_excise_allowlist.json",
    "CIVIC_RULESET_PATH": "<assets>/ruleset.excise-v1.json"
  }
}
```

Then try:

> Was our January beer excise return short of what the removals times the rate come to? Include the result hash.

> Do the operations reports balance (opening plus produced, less removed and losses, equals closing)?

> Did we miss any excise returns or file any late?

> Which periods had losses over 2 percent of production?

> List the wholesale customers and their addresses from the excise ledger. *(refused: `customer_accounts` is not exposed)*

**Rates and tolerances are data or parameters.** The excise rate lives in the ledger's `tax_rates` table with an effective date; a control reads the rate in force for the period, so a rate change is a new row, not a new signed ruleset, and the agent never supplies or guesses a rate. Filing due dates and the loss tolerance (`max_loss_bps`) vary by jurisdiction and are arguments with documented defaults.

**What a PASS means.** A figure was computed one fixed way, its check held, and its provenance verifies. It is evidence for a licensed professional or revenue auditor to confirm against the law that applies, not a TTB or state excise audit. All Penobscot Bay data is synthetic.

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
│   ├── sample_iolta_trust.sql           IOLTA seed script (Northfield Law, synthetic)
│   ├── sample_iolta_allowlist.json      IOLTA permitted tables and columns (no client_contacts)
│   ├── ruleset.iolta-v1.json(.sig)      signed IOLTA ruleset and its detached signature
│   ├── sample_excise_filings.sql        excise seed script (Penobscot Bay Brewing, synthetic)
│   ├── sample_excise_allowlist.json     excise permitted tables and columns (no customer_accounts)
│   ├── ruleset.excise-v1.json(.sig)     signed excise ruleset and its detached signature
│   └── civic-chain-ruleset-pub.pem      public key the ruleset signatures verify against
├── references/                          setup, controls and refusal reference for the agent
├── examples/                            worked transcripts (01-03 municipal, 04 insurance, 05 IOLTA, 06 excise)
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
- One custom warehouse per server: to run the municipal, insurance, IOLTA and excise demos together, add a server entry for each.
- `verify-setup.js` builds and checks only the municipal demo database; the insurance, IOLTA and excise databases are built with the one-liners above.
- Over MCP, `verify_audit` checks the hash chain but not signatures; the `cc-auditor audit` CLI checks both.

## Enterprise & custom deployments

Need read-only adapters for PostgreSQL, Snowflake or BigQuery, SSO / role-based access, or external compliance anchoring (WORM storage, RFC 3161 timestamping)? Contact info@civic-chain.com about Civic-Chain Auditor enterprise and custom deployments.

## Licence

Source-available under the **Civic-Chain Commercial Licence**; see the `LICENSE` file in the Civic-Chain Grant & Budget Auditor repository. The right to use is included with a Civic-Chain subscription. This is not open source, and may not be redistributed or resold.
