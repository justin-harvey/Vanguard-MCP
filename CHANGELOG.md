# Changelog

All notable changes to the Civic-Chain Grant & Budget Auditor are recorded here.
The project follows [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH.

## [Unreleased]

### Added — School Districts ruleset pack (seventh signed pack)
- A seventh domain pack beside the municipal, insurance, IOLTA, excise,
  property/HOA and nonprofit ones, on the same signed-ruleset + custom-warehouse
  seam (no engine change, no new dependency, no server, no new credential). Five
  controls for a school district's student activity funds, federal program costs
  and budget, each a named query with automatic checks, encoding GASB Statement
  No. 84 (student activity money the district holds in a custodial capacity is a
  fiduciary fund), the 2 CFR 200 period-of-performance requirement (2 CFR 200.403,
  200.309) and ordinary budget-versus-actual review:
  - **`schools/activity-negative-balances`** (`as_of`) — a student activity
    account whose collections do not cover its disbursements (an overdrawn
    custodial fund); an `empty` finding with a `unique` integrity check.
  - **`schools/activity-deposits-late`** (`deposit_days`, default 1) — activity
    cash deposited more than `deposit_days` days after collection, or not
    deposited at all; an `empty` finding (FLAG) with a `unique` integrity check.
  - **`schools/activity-unapproved-disbursements`** — an activity disbursement
    missing the advisor or the principal approval; an `empty` finding with a
    `unique` integrity check.
  - **`schools/federal-outside-period`** (`fiscal_year`) — a federal program cost
    charged before or after its award's period of performance; an `empty` finding
    with a `unique` integrity check.
  - **`schools/budget-variance`** (`fiscal_year`) — a budget line whose paid
    spending exceeds its amended budget (reuses the municipal pattern); a
    `compare` (`<=`) finding with `unique` and `total_matches` integrity checks.
- **The policy is the district's, not the engine's:** the late-deposit window
  (`deposit_days`) is a parameter with a documented default of 1, and the
  advisor-plus-principal approval rule is read from the ledger's
  `advisor_approved` / `principal_approved` flags, so a district's own policy is
  data, never new SQL.
- **Demo warehouse** (`assets/schools/`, mirrored into the skill): a synthetic
  Kennebec Valley Regional School Unit ledger (clean, so all five controls read
  PASS), a pure access-policy allow-list, and a deliberately **non-allow-listed
  `student_records` table** (student names, grade levels and meal-eligibility
  status, withheld under FERPA) so the guard visibly refuses student data; the
  controls carry activity-account, program and budget codes only.
- **Signed** `schools-v1` ruleset (`scripts/build-schools-ruleset.js`), signed
  offline with the same Civic-Chain key `acb80e87885da931`; ships in both asset
  copies with its detached signature.
- **Tests** (`test/schools-warehouse.test.js`, `test/schools-ruleset.test.js`,
  `test/schools-fixture.js`): clean PASS for all five controls, a targeted
  mutation (or deposit-window parameter) tripping each, the overspent-line-with-
  tying-total case, signature status, and the `student_records` refusal.
  `test/skill-drift.test.js` extended to resolve `schools/*` query names from the
  shipped ruleset. Full suite green on Node 22 (421 tests).
- **Skill routing and docs** (`SKILL.md`, `references/setup.md`,
  `references/refusals.md`,
  `examples/10-schools-activity-unapproved-disbursement.md`, and the skill,
  top-level and core READMEs): PASS/EXCEPTION/FLAG presentation per control, the
  deposit-window parameter, and the student-records refusal.

### Added — Nonprofit Restricted Funds ruleset pack (sixth signed pack)
- A sixth domain pack beside the municipal, insurance, IOLTA, excise and
  property/HOA ones, on the same signed-ruleset + custom-warehouse seam (no
  engine change, no new dependency, no server, no new credential). Five controls
  for a nonprofit's donor-restricted funds and federal awards, each a named query
  with automatic checks, encoding ASC 958 as amended by ASU 2016-14 (net assets
  with and without donor restrictions, releases from restriction, and expenses
  analyzed by both nature and function) and the Single Audit requirement in
  2 CFR 200.501:
  - **`nonprofit/restricted-spending`** (`fiscal_year`) — expenses charged to a
    donor-restricted fund outside its purpose or time window; an `empty` finding
    with a `unique` integrity check.
  - **`nonprofit/releases-vs-spending`** (`fiscal_year`) — per restricted fund:
    the amount released from restriction against the qualifying spending that
    justified it; a `compare` (`<=`) finding with a `unique` integrity check.
  - **`nonprofit/functional-expense-tie`** (`fiscal_year`) — the nature-by-function
    expense grid; a `total_matches` integrity tie to total expenses, plus a
    `compare` (`>=`) finding for any negative cell, with a `unique` integrity
    check per cell.
  - **`nonprofit/restricted-cash-coverage`** (`as_of`) — liquid assets (cash and
    investments) against net assets with donor restrictions; a `compare` (`>=`)
    finding with a `total_matches` integrity recompute.
  - **`nonprofit/single-audit-threshold`** (`fiscal_year`, `threshold_cents`,
    default 100000000) — federal award spending in the year against the Single
    Audit trigger; a `compare` (`<`) finding with a `unique` integrity check.
- **The threshold is a parameter, not code:** the $1,000,000 Single Audit trigger
  is `threshold_cents` with a documented default (raised from $750,000 for fiscal
  years beginning on or after October 1, 2024), so an OMB change is an argument or
  version bump, never new SQL. A fund's restriction (purpose and window) lives in
  the `funds` table, so a restriction change is a data update.
- **Demo warehouse** (`assets/nonprofit/`, mirrored into the skill): a synthetic
  Merrymeeting Bay Community Services fund-accounting ledger (clean, so all five
  controls read PASS), a pure access-policy allow-list, and a deliberately
  **non-allow-listed `donor_pii` table** (donor names, addresses and gift
  histories) so the guard visibly refuses donor data; the controls carry fund,
  line and program codes only.
- **Signed** `nonprofit-v1` ruleset (`scripts/build-nonprofit-ruleset.js`), signed
  offline with the same Civic-Chain key `acb80e87885da931`; ships in both asset
  copies with its detached signature.
- **Tests** (`test/nonprofit-warehouse.test.js`, `test/nonprofit-ruleset.test.js`,
  `test/nonprofit-fixture.js`): clean PASS for all five controls, a targeted
  mutation (or threshold parameter) tripping each, the negative-cell-with-tying-grid
  case, signature status, and the `donor_pii` refusal. `test/skill-drift.test.js`
  extended to resolve `nonprofit/*` query names from the shipped ruleset. Full
  suite green on Node 22 (406 tests).
- **Skill routing and docs** (`SKILL.md`, `references/setup.md`,
  `references/refusals.md`, `examples/09-nonprofit-restricted-spending.md`, and the
  skill, top-level and core READMEs): PASS/EXCEPTION/FLAG presentation per control,
  the threshold-as-parameter rule, and the donor-data refusal.

### Added — Property Management & HOA ruleset pack (fifth pack, two signed rulesets)
- A pack family beside the municipal, insurance, IOLTA and excise ones, on the
  same signed-ruleset + custom-warehouse seam (no engine change, no new
  dependency, no server, no new credential). Two signed rulesets, served as two
  custom warehouses, with seven controls total, each a named query with
  automatic checks:
  - **Broker/property-manager trust** (`property-trust-v1`, warehouse
    `property`), encoding broker escrow-reconciliation practice (for example
    Florida Rule 61J2-14.012) and state security-deposit law:
    - **`property/trust-vs-liability`** (`as_of`) — the reconciled bank balance
      against the itemized trust liability (the sum of every beneficiary ledger);
      a `compare` (`>=`) finding with a `total_matches` integrity recompute.
    - **`property/negative-owner-balances`** (`as_of`) — owner ledgers overdrawn
      below zero; an `empty` finding with a `unique` integrity check.
    - **`property/deposits-held-vs-owed`** (`as_of`) — active leases whose
      security deposit is not held in trust in full; an `empty` finding with a
      `unique` integrity check.
    - **`property/deposit-return-overdue`** (`return_days`, default 30) — ended
      leases whose deposit is unreturned past the deadline; an `empty` finding
      with a `unique` integrity check.
  - **HOA board review** (`hoa-v1`, warehouse `hoa`), encoding the monthly
    board-review duties in California Civil Code s 5500 and the reserve
    prior-approval rule in s 5502:
    - **`hoa/reserve-transfers-unapproved`** — transfers out of reserve with no
      board approval on record; an `empty` finding with a `unique` integrity
      check. A transfer into reserve needs no approval and is not reported.
    - **`hoa/budget-variance`** (`fiscal_year`) — adopted budget, spending and
      remaining per operating line; a `compare` (`<=`) finding with a `unique`
      integrity check.
    - **`hoa/delinquent-assessments`** (`days_past_due`, default 60) — unpaid
      owner assessments aged past the threshold; an `empty` finding with a
      `unique` integrity check.
- **Deadlines and thresholds are parameters, not code:** the deposit-return
  deadline and the assessment aging threshold vary by state and association and
  are optional params with documented defaults, so a different rule is an
  argument, never a new signed ruleset.
- **Demo warehouses** (`assets/property/`, `assets/hoa/`, mirrored into the
  skill): a synthetic Sunset Key Realty & Property Management broker-trust ledger
  and a synthetic Palm Grove Community Association HOA ledger, both clean so every
  control reads PASS, each with a pure access-policy allow-list and a deliberately
  **non-allow-listed `resident_pii` table** (tenant and owner names, SSNs and
  bank accounts) so the guard visibly refuses resident data; the controls carry
  ledger, property, lease, unit, line and transfer IDs only.
- **Signed** `property-trust-v1` and `hoa-v1` rulesets
  (`scripts/build-property-ruleset.js`, `scripts/build-hoa-ruleset.js`), signed
  offline with the same Civic-Chain key `acb80e87885da931`; each ships in both
  asset copies with its detached signature.
- **Tests** (`test/property-warehouse.test.js`, `test/property-ruleset.test.js`,
  `test/property-fixture.js`, `test/hoa-warehouse.test.js`,
  `test/hoa-ruleset.test.js`, `test/hoa-fixture.js`): clean PASS for all seven
  controls, a targeted mutation (or threshold parameter) tripping each, the
  reserve-contribution-is-not-a-finding case, signature status, and the
  `resident_pii` refusal. `test/skill-drift.test.js` extended to resolve
  `property/*` and `hoa/*` query names from the shipped rulesets. Full suite
  green on Node 22 (406 tests).
- **Skill routing and docs** (`SKILL.md`, `references/setup.md`,
  `references/refusals.md`, `examples/07-property-trust-shortfall.md`,
  `examples/08-hoa-reserve-unapproved.md`, and the skill, top-level and core
  READMEs): PASS/EXCEPTION/FLAG presentation per control, the parameter-as-data
  rule, and the resident-data refusal.

### Added — Excise Tax ruleset pack (fourth signed pack)
- A fourth domain pack beside the municipal, insurance and IOLTA ones, on the
  same signed-ruleset + custom-warehouse seam (no engine change, no new
  dependency, no server, no new credential). Five controls for an excise
  licensee's filings (the demo is a beer brewery), each a named query with
  automatic checks, encoding TTB practice (27 CFR part 25, operations reports
  under 27 CFR 25.297) and common state excise reconciliation:
  - **`excise/liability-vs-remitted`** (`period`) — per period: taxable barrels
    removed, the per-barrel rate in force, the expected tax and the tax paid; a
    `compare` (`>=`) finding that the tax paid covers the liability, plus a
    `total_matches` integrity recompute of the removals volume.
  - **`excise/inventory-rollforward`** (`period`) — per period: opening +
    produced − removed − losses against the reported closing barrels; a
    `compare` (`=`) finding with a `unique` integrity check.
  - **`excise/report-vs-return`** (`period`) — per period: barrels removed on the
    operations report against barrels reported on the return; a `compare` (`=`)
    finding with a `unique` integrity check.
  - **`excise/missing-or-late-filings`** — periods with activity but no return,
    or a return filed after its due date; an `empty` finding with a `unique`
    integrity check.
  - **`excise/loss-variance`** (`max_loss_bps`, default 300) — periods whose
    losses, in basis points of production, exceed the tolerance (a diversion
    signal); an `empty` finding with a `unique` integrity check.
- **Rates are data, not code:** the per-barrel rate lives in a `tax_rates` table
  with an effective date, and a control reads the rate in force for the period,
  so a rate change is a new row, never a new signed ruleset. The demo ships the
  old full rate and the current reduced small-brewer rate to prove the
  effective-date selection.
- **Demo warehouse** (`assets/excise/`, mirrored into the skill): a synthetic
  Penobscot Bay Brewing Co. seed (clean, so all five controls read PASS), a
  pure access-policy allow-list, and a deliberately **non-allow-listed
  `customer_accounts` table** (wholesale-account names, addresses, license
  numbers; patient-registry IDs in a cannabis build) so the guard visibly
  refuses customer data; the filings carry product class and period only.
- **Signed** `excise-v1` ruleset (`scripts/build-excise-ruleset.js`), signed
  offline with the same Civic-Chain key `acb80e87885da931`; ships in both asset
  copies with its detached signature.
- **Tests** (`test/excise-warehouse.test.js`, `test/excise-ruleset.test.js`,
  `test/excise-fixture.js`): clean PASS for all five controls, a targeted
  mutation (or threshold parameter) tripping each, the rate-in-force selection,
  signature status, and the `customer_accounts` refusal. `test/skill-drift.test.js`
  extended to resolve `excise/*` query names from the shipped ruleset. Full
  suite green on Node 22 (406 tests).
- **Skill routing and docs** (`SKILL.md`, `references/setup.md`,
  `references/refusals.md`, `examples/06-excise-underpaid-return.md`, and the
  skill, top-level and core READMEs): PASS/EXCEPTION/FLAG presentation per
  control, the rate-as-data rule, and the customer-data refusal.

### Added — Law Firm Trust (IOLTA) ruleset pack (third signed pack)
- A third domain pack beside the municipal and insurance ones, on the same
  signed-ruleset + custom-warehouse seam (no engine change, no new dependency,
  no server, no new credential). Five controls for a law firm's client trust
  (IOLTA) account, each a named query with automatic checks, encoding ABA Model
  Rule 1.15 and common reconciliation practice:
  - **`iolta/three-way-reconciliation`** (`as_of`) — adjusted bank balance,
    trust journal balance and the sum of the client ledgers; two `compare` (`=`)
    findings that the three tie, plus a `total_matches` integrity recompute of
    the client-ledger sum.
  - **`iolta/negative-client-balances`** (`as_of`) — overdrawn client ledgers
    (one client's money funding another's); an `empty` finding with a `unique`
    integrity check.
  - **`iolta/unsupported-fee-transfers`** — earned-fee transfers out of trust
    with no invoice or larger than the invoice; an `empty` finding.
  - **`iolta/firm-funds-in-trust`** (`max_firm_cents`, default 25000) — firm
    money held in trust above the bank-charge allowance (commingling); an
    `empty` finding.
  - **`iolta/dormant-balances`** (`dormant_days`, default 365) — positive client
    balances idle past the threshold; an `empty` finding (housekeeping/escheat).
- **Demo warehouse** (`assets/iolta/`, mirrored into the skill): a synthetic
  Northfield Law Group seed (clean, so all five controls read PASS), a
  pure access-policy allow-list, and a deliberately **non-allow-listed
  `client_contacts` table** (client names, addresses) so the guard visibly
  refuses client PII; the ledger carries client and matter IDs only.
- **Signed** `iolta-v1` ruleset (`scripts/build-iolta-ruleset.js`), signed
  offline with the same Civic-Chain key `acb80e87885da931`; ships in both asset
  copies with its detached signature.
- **State rules as parameters, not assertions:** reconciliation frequency, the
  dormancy period and the firm buffer are arguments with documented defaults, so
  a firm passes its own state's rule rather than a hardcoded one.
- **Tests** (`test/iolta-warehouse.test.js`, `test/iolta-ruleset.test.js`,
  `test/iolta-fixture.js`): clean PASS for all five controls, a targeted
  mutation (or threshold parameter) tripping each, the materiality/allowance
  parameters, signature status, and the `client_contacts` PII refusal.
  `test/skill-drift.test.js` extended to resolve `iolta/*` query names from the
  shipped ruleset. Full suite green on Node 22 (347 tests).
- **Skill routing and docs** (`SKILL.md`, `references/setup.md`,
  `references/refusals.md`, `examples/05-iolta-overdrawn-client-ledger.md`, and
  the skill, top-level and core READMEs): PASS/EXCEPTION/FLAG presentation per
  control, the client-PII refusal, and the one-custom-warehouse-per-server setup.

### Added — Insurance & Fiduciary ruleset pack (second signed pack)
- A second domain pack beside the municipal one, built on the existing signed
  ruleset + custom-warehouse seam (no change to the municipal CSV-import path, no
  server, no new credential). Three controls for an insurance agency's premium
  trust, each shipped as a named query with automatic checks:
  - **`insurance/trust-account-solvency`** — premiums collected, carrier
    remittances, commission drawn, the net trust liability, and the latest actual
    bank balance; a `compare` finding (`bank_balance_cents >= net_trust_liability_cents`)
    and a `total_matches` integrity check reconciling the premium total.
  - **`insurance/commission-variance-audit`** — active/bound policies whose
    received commission varies from the contracted basis-point rate by more than
    a materiality threshold (`min_variance_cents`, default 100); an `empty`
    finding, so a clean result is no rows.
  - **`insurance/eo-unbound-exposure`** — policies holding client premium with no
    carrier-confirmed binder; an `empty` finding.
- **New engine check type `empty`** (`src/named-queries.js`): a finding that
  flags when a query whose SQL already filters to only the offending rows (a
  `HAVING` clause) returns any row, with an optional `key` column sampled in the
  detail. Pure; same validation path as the other checks.
- **Guard coverage proven for the pack's SQL** (`test/guard.test.js`): the three
  canonical queries pass unchanged (scalar subquery with `ORDER BY ... LIMIT`,
  `ABS`, integer division, aliased `LEFT JOIN`); no guard change was needed, and
  `SELECT *`, the PII table and off-list columns are still refused.
- **Demo warehouse** (`assets/insurance/`, mirrored into the skill): a synthetic
  Harborline Insurance Agency seed (clean, so all three controls read PASS), a
  pure access-policy allow-list, and a deliberately **non-allow-listed
  `insured_pii` table** (SSNs, health notes) so the guard visibly refuses
  policyholder PII, the enforcement behind the pack's "no PII" claim.
- **Signed** `insurance-v1` ruleset (`scripts/build-insurance-ruleset.js`),
  signed offline with the same Civic-Chain key `acb80e87885da931`; ships in both
  asset copies with its detached signature, pinned byte-identical by the drift
  test.
- **Skill routing** (`SKILL.md`, `references/setup.md`, `references/refusals.md`,
  `examples/04-insurance-trust-shortfall.md`): how to present PASS / EXCEPTION /
  FLAG for each control, the empty-result-is-clean rule, the PII refusal, and
  Posture-A claim discipline (evidence for a licensed professional, not a
  department-of-insurance audit or an E&O opinion). Skill-drift test extended to
  validate the insurance query names against the shipped ruleset.
- Tests: `test/insurance-warehouse.test.js`, `test/insurance-ruleset.test.js`
  (clean PASS and each control tripped by a targeted mutation, the materiality
  param, and the signed-status checks), plus the `empty`-check and guard-coverage
  units.

### Added — security policy + published signing key (V1, part)
- **`SECURITY.md`** at the repo root and inside the npm package (added to the
  package `files`): how to report a vulnerability (`info@civic-chain.com`), a
  plain statement of what runs locally (no telemetry, no Civic-Chain servers in
  the data path, read-only by construction), and the **ruleset signing key
  published for pinning** — key id `acb80e87885da931`, full SPKI DER SHA-256
  fingerprint, and the `openssl` one-liner to recompute it from the bundled
  `assets/civic-chain-ruleset-pub.pem`. A ruleset whose `signedBy` does not match
  the published key id is untrusted. README links it from the repo map.

### Added — grant-register import over MCP
- The multi-file grant-register import (the CLI's `--grants`/`--grants-map`) is
  now exposed over the MCP surface so the agent loop can drive it:
  `propose_csv_mapping` takes an optional **`grantFile`** and returns the
  proposed grant-register mapping under `grantRegister`; `import_csv` takes
  optional **`grantFile` + `grantMapping`** and applies the register onto the
  just-built ledger, recording its own source-SHA-256 audit entry, so
  `municipal/grant-status` measures spending against real award amounts instead
  of award-0 placeholders. Both route through the existing `runImport`; the tool
  names are unchanged. New `test/mcp.test.js` coverage (advertise-gate, propose,
  apply, and the refusal when a grant file is given with no confirmed mapping).

### Added — grant-drawdowns import (the third file)
- A grant register fills in each award but says nothing about the cash actually
  drawn from the grantor, so `municipal/grant-status` reported **drawn = 0** —
  honest, but blind to its cash-ahead-of-spending check. A third import of the
  buyer's drawdown register now fills `grant_drawdowns`.
  - **Library (`src/import-csv.js`).** `CANONICAL_DRAWDOWN_FIELDS`
    (`grant_id`, `amount`, `request_date`, optional `received_date` / `status` /
    `drawdown_id`), `coerceDrawdownStatus` (received/pending, or throw), and
    `applyGrantDrawdownsToLedger` — a transactional insert onto the ledger the
    expenditure (and optional register) import already built. Every drawdown's
    `grant_id` must resolve to a grant on the ledger (else refused, naming it);
    `drawdown_id` is carried from the file when mapped (and must be unique) or
    generated `DD-0001…` in file order. Status defaults from the presence of a
    received date only when the file left it blank.
  - **CLI (`cc-auditor import`).** New **`--drawdowns`** / **`--drawdowns-map`**,
    mirroring `--grants`. Each file records its own source-SHA-256 audit entry
    (`import` → `import-grants` → `import-drawdowns`).
  - **MCP.** `propose_csv_mapping` takes an optional **`drawdownFile`** (proposal
    under `grantDrawdowns`); `import_csv` takes optional **`drawdownFile` +
    `drawdownMapping`**. Tool names unchanged; advertised only with an import
    folder.
  - New `test/grant-drawdowns.test.js` (coercion, insert, carried/generated ids,
    unknown-grant refusal, rollback, end-to-end three-file import with a third
    source-hash entry) + `test/mcp.test.js` drawdown coverage.

### Added — rulesets as the product (S9)
- The named queries and their checks are now a **versioned, signed Civic-Chain
  ruleset**, separate from the buyer's access policy (the allow-list). Every
  result reports whether the ruleset is the one Civic-Chain published.
  - **`src/ruleset.js`.** A ruleset is `{ name, version, changelog, queries }`.
    Its **content hash** is the SHA-256 of the file's exact bytes, so editing a
    single byte changes it. A detached `<file>.sig` carries an Ed25519 signature
    over that hash, made **offline** with the Civic-Chain private key (never in
    the repo or CI); the public key ships in the package
    (`assets/civic-chain-ruleset-pub.pem`). `verifyRuleset` reports **signed**
    (bytes match the trusted key's signature), **modified** (a signature exists
    but does not verify — edited, or another key), or **unsigned** (no signature).
  - **Bundled, signed municipal ruleset.** `assets/municipal/ruleset.municipal-v1.json`
    (+ `.sig`) carries the three queries — `grant-status`, `spending-by-vendor`,
    `budget-variance` — with a version and changelog. Rulesets **ship inside the
    npm package**; a subscription update is a new package version, no registry
    server. `scripts/build-municipal-ruleset.js` rebuilds/signs it from the
    allow-list (one SQL source of truth); both the package and the skill asset
    copies stay byte-identical (guarded by `paths.test.js`).
  - **Provenance carries it.** `CIVIC_RULESET_PATH` selects a ruleset (its queries
    replace the allow-list's); `CIVIC_DATA_HASH` records a data fingerprint. Every
    audit entry and `provenanceOf` result now carries **`rulesetHash`**, **`dataHash`**
    and the ruleset's `{ name, version, status }`, so the same CSV and ruleset
    version on two machines produce identical hashes, and a modified ruleset is
    visible in every result.
  - **Import runs under the ruleset.** `cc-auditor import` now runs the gate
    queries under the signed `municipal-v1` ruleset, records `rulesetHash` +
    `dataHash` (the source CSV's SHA-256) on the import entry, and emits
    `CIVIC_RULESET_PATH`/`CIVIC_DATA_HASH` in the MCP config it prints.
  - **`cc-auditor ruleset`** — `list` (bundled rulesets + signature status),
    `show <file>`, `keygen [--out key.pem]` (generate an offline Civic-Chain key),
    and `sign <file> --key key.pem` (write a detached signature).
  - New `test/ruleset.test.js` (11 tests): content-hash determinism, the
    signed/unsigned/modified verdicts, the one-byte-flip → modified rule, the
    bundled ruleset verifying against the shipped key, and cross-machine hash
    determinism.

### Added — import the buyer's CSV (S8)
- A buyer can now point the three named queries at **their own** exported
  expenditure CSV, locally, with a tamper-evident record of exactly which file
  was imported.
  - **`cc-auditor import <file.csv>`.** Two steps, on purpose. With no `--map` it
    reads the CSV's headers (and a sample of rows to confirm types) and *proposes*
    a column mapping onto the canonical schema, writing nothing. With `--map
    mapping.json` it builds the ledger, records the source hash, and runs the
    three queries. Only a confirmed mapping is ever written.
  - **Files by name, from a named folder — never pasted data.** `CIVIC_IMPORT_DIR`
    names the folder CSVs are read from; a name that escapes it (a `..` traversal
    or an absolute path) is refused before anything is opened
    (`paths.js` `resolveImportPath`, new `ImportPathError`).
  - **`src/import-csv.js`.** A zero-dependency RFC-4180 parser (a ragged row is an
    error, not a silent drop), money coerced to **integer cents** (never a float;
    accounting parentheses, `$`, thousands separators, ≤2 decimals), dates
    normalised to ISO, status mapped to paid/pending/void, fiscal year derived
    July–June. A malformed value **aborts** the import naming the row and column,
    rather than coercing to 0/null. Builds **Canonical Municipal Schema v1** with
    the derived dimension rows (vendors, departments, funds, budget lines, and any
    referenced grants) the expenditures reference, atomically (temp file + rename).
  - **Source provenance recorded.** The source file's SHA-256, byte length, row
    count and the confirmed mapping are the first entry of the imported ledger's
    own audit chain; the confirmed mapping is also saved beside the ledger
    (`mapping.json`) so an import is reviewable and reproducible.
  - **The gate.** After an import the engine runs `grant-status`,
    `spending-by-vendor` and `budget-variance` and reports each one's integrity
    and findings. A clean import answers all three with integrity `pass`.
  - **MCP tools** `propose_csv_mapping` (read-only) and `import_csv` (confirmed
    import), advertised only when `CIVIC_IMPORT_DIR` is set (so the static browser
    demo never exposes them); the file name is confined to the import folder, and
    the ledger/log/mapping paths are server-derived, never taken from the wire.
  - New `test/import-csv.test.js` (18 tests) and an anonymized, fictional
    expenditure fixture (`test/fixtures/riverton_expenditures.csv`) exercise the
    gate, money/date exactness, malformed-row rejection and path confinement.

### Added — one-line install (S6)
- The engine now publishes to npm as **`@civic-chain/auditor`** with a `bin`
  (`cc-auditor`, and `civic-chain-auditor`), a `files` whitelist, and npm
  **provenance** enabled, so a buyer verifies the package came from this repo.
  - **Writable data directory.** The engine no longer writes inside its own
    install (fatal once it lives under a read-only `node_modules`). A new
    `src/paths.js` resolves a per-user data directory — `CIVIC_DATA_DIR`, else the
    platform convention (`%APPDATA%`, `~/Library/Application Support`,
    `$XDG_DATA_HOME`/`~/.local/share`), all under `civic-chain-auditor`. The
    default SaaS, markets, Enron and LSEG databases and every audit log now live
    there; the shipped schemas and the municipal sample stay read-only in the
    package.
  - **First-run seed.** `cc-auditor ask`, and `cc-auditor mcp` with no warehouse
    configured, build the demo warehouse on first use (`ensureSeeded`), so a
    fresh install answers immediately.
  - **Bundled municipal demo.** The Town of Sampleton seed and allow-list ship in
    the package (`assets/municipal`, kept byte-identical to the skill copy by a
    drift test). `src/municipal.js` builds them into the data directory on demand.
  - **`cc-auditor doctor`.** A local-only setup check (no network, no subprocess,
    no credential read): verifies Node 22+/`node:sqlite`, a writable data dir,
    builds the municipal demo, loads it through the engine as a smoke test, and
    prints a ready-to-paste `npx`-based MCP client config pointing at the stable
    data-dir copies. Replaces the checkout-oriented `skills/.../verify-setup.js`
    for the npm path. New `test/paths.test.js` and `test/doctor.test.js` cover it.

### Added — in-browser demo (S7B)
- The public demo now runs the engine **entirely in the visitor's browser**:
  no server, no proxy, no endpoint. The page reads the synthetic Town of
  Sampleton ledger, runs the three named queries with their checks, the guard,
  result hashing and the audit chain locally, and sends nothing anywhere.
  - **Shared engine, two leaves.** New `src/browser/engine.js` assembles the
    *same* engine source the Node package runs (`guard.js`, the new pure
    `named-core.js`, `lineage.js`, `audit-core.js`); only SQLite (WASM via
    sql.js, in-memory, `PRAGMA query_only`) and hashing (the new dependency-free
    `src/platform/sha256.js`) differ from Node.
  - **Parity gate.** `test/browser-parity.test.js` runs every demo case through
    both engines and asserts identical rows, checks, findings, executed SQL and
    **result hash**; `test/sha256.test.js` pins the pure SHA-256 against
    `node:crypto`.
  - **Build.** `npm run build:demo` (esbuild) emits `site/assets/demo-engine.js`
    plus the self-hosted `sql-wasm.{js,wasm}`, inlining the seed SQL and
    allow-list from the skill assets (one source of truth). ~1.0 MB transferred.
    Built files are committed, so Netlify stays build-free.
  - **Page.** `site/demo.html` runs the queries locally, shows the executed SQL,
    and adds *Reset chain* and *Tamper with an entry* controls plus a guarded
    "try your own SQL" box. A labelled sample remains for when WASM cannot load.
  - **Locked down.** `netlify.toml` serves a Content-Security-Policy
    (`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`), verified with
    no violations by `scripts/verify-demo.mjs` (headless Chromium: engine loads,
    chain verifies/tampers/resets, guard refuses out-of-bounds SQL, zero
    network requests after load).

### Changed — engine seam (no behaviour change in Node)
- Split three Node-bound modules so their logic is pure and their I/O injected,
  with all existing tests passing unchanged: hashing moved behind
  `src/platform/hash.js` (Node `node:crypto`, browser pure SHA-256); the chain
  logic moved to pure `src/audit-core.js` (`appendEntry`/`verifyEntries`), with
  `audit.js` the file-backed, signing wrapper; the orchestration moved to pure
  `src/named-core.js`, with `named-run.js` the Node wrapper; `parseAllowlist`
  moved to pure `src/allowlist.js`. `provenanceOf` is now one shared definition.
- Rebranded the demo surface to **Civic-Chain Grant & Budget Auditor** across
  `site/` and `netlify.toml` (carries C2 into the web layer).

### Removed — the S7 hosted path
- Deleted `Dockerfile`, `.dockerignore`, `fly.toml` and `supabase/` (the Fly
  engine and Supabase edge proxy). `cc-auditor serve` stays for enterprise use
  and still refuses to start without `ENGINE_SERVICE_TOKEN`. The live Fly app,
  Supabase function and its token are torn down post-deploy per the checklist in
  `deploy/README.md`.

## [1.0.0] — 2026-11-14

**This release is the licence cut-over.** Everything published at or after the
`v1.0.0` tag is offered under the **Civic-Chain Commercial Licence** (see
`LICENSE`): source-available, right-to-use with a subscription, no
redistribution or resale. Everything published *before* this tag (the `0.x`
history, up to and including commit `88e08a3`) was offered under the MIT Licence
and stays MIT for anyone who already holds it. This change is not retroactive.

### Changed — licence (C1)
- Dropped MIT going forward; added the counsel-pending Civic-Chain Commercial
  Licence at the repository root and inside the `vanguard-core` package.
- Set `license` in `package.json` to `SEE LICENSE IN LICENSE`.
- Removed every "MIT" and "open source" claim about the engine from the docs.
  The engine is **source-available**, not open source.
- Added a copyright-header convention for new files (`COPYRIGHT.md`).

### Changed — rebrand (C2)
- Renamed the product to **Civic-Chain Grant & Budget Auditor**, retiring the
  "Vanguard" name a buyer sees. CLI display name is now `cc-auditor`.
- Environment variables are now `CIVIC_*` (`CIVIC_DB_PATH`, `CIVIC_ALLOWLIST_PATH`,
  `CIVIC_AUDIT_LOG`, `CIVIC_SIGNING_KEY[_FILE]`, `CIVIC_CORE`). The former
  `VANGUARD_*` names are honoured as a fallback for one release, then removed.
- MCP server name is `civic-chain-auditor`; resource URIs use the
  `civic-chain://` scheme; the host config key is `civic-chain-auditor`.
- Renamed the agent skill folder to `skills/civic-chain-auditor/`.

### Security (C3)
- `cc-auditor serve` (the HTTP API) now **refuses to start** unless
  `ENGINE_SERVICE_TOKEN` is set. It previously ran unauthenticated by default.

### Release hygiene (C3)
- Adopted semantic versioning starting at 1.0.0; this file is the record of what
  subscribers receive.
- Merged the engine and skill onto `main` so a fresh clone can complete setup.
- Excluded `scripts/package.sh` from the shipped skill zip.

### Deprecated
- `VANGUARD_*` environment variables. Use the `CIVIC_*` names; the aliases will
  be removed in the next minor release.

[1.0.0]: https://github.com/justin-harvey/Vanguard-MCP/releases/tag/v1.0.0
