---
name: civic-chain-auditor
description: Use when the user asks to audit grant spending, check a municipal or public budget, track grant drawdowns against expenditures, find budget overruns or overspent line items, break spending down by vendor, reconcile an insurance agency's premium trust account, audit carrier commission variances or errors-and-omissions exposure on unbound policies, reconcile a law firm's client trust (IOLTA) account three ways, find overdrawn client ledgers or unsupported fee transfers, reconcile an excise licensee's filings (a brewery's or other alcohol, tobacco or cannabis business's), check an excise return against taxable removals, tie an operations report to a tax return, find missing or late excise filings or losses over tolerance, reconcile a real estate broker's or property manager's trust account, check that tenant security deposits are held in trust or returned on time, review an HOA's reserve transfers, operating budget variance or delinquent owner assessments, audit a nonprofit's donor-restricted funds, check whether restricted money was spent outside its purpose or released ahead of spending, tie a statement of functional expenses, or test whether federal spending reaches the Single Audit threshold, verify an audit log, or get financial figures they can trust and reproduce. Answers through the Civic-Chain Auditor MCP server (required): every number comes from a read-only SQL query checked against the source rows, with a result hash and a tamper-evident audit trail. Also covers SOC 2 evidence controls and ledger reconciliation. Includes a demo town budget ledger, a demo insurance premium-trust ledger, a demo law-firm client-trust ledger, a demo beer-excise filings ledger, a demo broker-trust ledger, a demo HOA ledger and a demo nonprofit fund-accounting ledger.
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

Read the resource `civic-chain://warehouses` once per session to see which warehouses are connected, which accept free text, and (for custom warehouses) what named queries they expose with their parameters. The municipal demo exposes `municipal/grant-status`, `municipal/spending-by-vendor` and `municipal/budget-variance`. The insurance demo exposes `insurance/trust-account-solvency`, `insurance/commission-variance-audit` and `insurance/eo-unbound-exposure`. The IOLTA demo exposes `iolta/three-way-reconciliation`, `iolta/negative-client-balances`, `iolta/unsupported-fee-transfers`, `iolta/firm-funds-in-trust` and `iolta/dormant-balances`. The excise demo exposes `excise/liability-vs-remitted`, `excise/inventory-rollforward`, `excise/report-vs-return`, `excise/missing-or-late-filings` and `excise/loss-variance`. The property demo exposes `property/trust-vs-liability`, `property/negative-owner-balances`, `property/deposits-held-vs-owed` and `property/deposit-return-overdue`, and the HOA demo `hoa/reserve-transfers-unapproved`, `hoa/budget-variance` and `hoa/delinquent-assessments`. The nonprofit demo exposes `nonprofit/restricted-spending`, `nonprofit/releases-vs-spending`, `nonprofit/functional-expense-tie`, `nonprofit/restricted-cash-coverage` and `nonprofit/single-audit-threshold`. Built-in canonical queries and the full catalog are in `references/setup.md`.

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

## Insurance & Fiduciary pack

When the `insurance` warehouse is configured, three named queries audit an agency's premium trust. Call each with `run_canonical`; all are no-credential and carry automatic checks, so route through them exactly as the municipal named queries, reading `integrity` first, then the findings.

| Query | Args | Reports |
|---|---|---|
| `insurance/trust-account-solvency` | none | Premiums collected, carrier remittances, commission drawn, the net trust liability, and the latest actual bank balance. Finding when the balance does not cover the liability. |
| `insurance/commission-variance-audit` | `min_variance_cents` (optional, default 100) | Active or bound policies whose received commission varies from the contracted rate by more than the threshold. |
| `insurance/eo-unbound-exposure` | none | Policies holding client premium with no carrier-confirmed binder. |

How to present each result:

- **`trust-account-solvency`** carries the finding check `trust-solvent` (a `compare`: `bank_balance_cents >= net_trust_liability_cents`). `status: "pass"` means the trust is solvent, present the figures. `status: "flag"` is an **EXCEPTION**: report it as a fiduciary trust shortfall using the check's `message`, state the net liability and the bank balance from `rows[0]`, and do not retry (the same snapshot flags again). The integrity check `collected-reconciles` confirms the premium total against an independent query; if it is `flag` or `error`, say the figures are not trustworthy.
- **`commission-variance-audit`** carries the finding check `no-commission-variance` (an `empty` check). An **empty result is the clean, passing case**: say every active policy was paid as contracted. Any returned row is a **FLAG**: report each `policy_id` with its `expected_comm_cents`, `actual_paid_cents` and `variance_cents`, and say to review the carrier statements before any producer payout. A negative `variance_cents` is an underpayment; a positive one is an overpayment or missed chargeback.
- **`eo-unbound-exposure`** carries the finding check `no-unbound-premium` (an `empty` check). An **empty result is the clean, passing case**: say every dollar of client premium held corresponds to confirmed coverage. Any returned row is an **EXCEPTION**: report the `policy_id` and `client_funds_held_cents` and say it is an immediate errors-and-omissions exposure, confirm the binder or return the premium.

For the `empty` checks, remember an empty result means the control **passed**; it is not "no data". Only present an EXCEPTION or FLAG when a row is actually returned.

**Policyholder PII is never readable.** The agency's SSNs and health data live in an `insured_pii` table that is not on the allow-list, so any question that would read it is refused (`table_not_allowed`, or `column_not_allowed` for a withheld column). This is by design: say the engine does not expose policyholder PII, and do not try to reach it another way. These controls need none of it.

**Claim discipline.** A PASS means a figure was computed one blessed way, its assertion held, and its provenance verifies, never that the agency is "compliant" or "certified". These controls produce evidence for a licensed professional to confirm against the agency's own obligations; they are not a department-of-insurance audit or an E&O coverage opinion. The demo data is synthetic.

## Law Firm Trust (IOLTA) pack

When the `iolta` warehouse is configured, five named queries audit a law firm's client trust account against ABA Model Rule 1.15 and common reconciliation practice. Call each with `run_canonical`; all are no-credential and carry automatic checks, so route through them exactly as the municipal named queries, reading `integrity` first, then the findings.

| Query | Args | Reports |
|---|---|---|
| `iolta/three-way-reconciliation` | `as_of` (optional, YYYY-MM-DD) | The adjusted bank balance, the trust journal balance, and the sum of the client ledgers. Findings when the three do not tie. |
| `iolta/negative-client-balances` | `as_of` (optional) | Client ledgers with a balance below zero. |
| `iolta/unsupported-fee-transfers` | none | Earned-fee transfers out of trust with no invoice, or larger than the invoice. |
| `iolta/firm-funds-in-trust` | `max_firm_cents` (optional, default 25000) | Firm money held in trust above the bank-charge allowance (commingling). |
| `iolta/dormant-balances` | `dormant_days` (optional, default 365) | Client ledgers with a positive balance idle past the threshold. |

How to present each result:

- **`three-way-reconciliation`** carries the integrity check `client-ledgers-recompute` (a `total_matches`) and two finding checks, both `compare` with `=`: `bank-ties-journal` (`adjusted_bank_cents = journal_balance_cents`) and `journal-ties-clients` (`journal_balance_cents = client_ledger_sum_cents`). When both finding checks are `pass`, the account reconciles: present the three figures from `rows[0]` and say they tie. If either is `flag`, it is a **reconciliation break**: report which tie failed using the check's `message` and the two figures from `rows[0]`, and do not retry. If the integrity check `client-ledgers-recompute` is `flag` or `error`, say the figures are not trustworthy.
- **`negative-client-balances`** carries the finding check `no-negative-balances` (an `empty` check). An **empty result is the clean, passing case**: say no client ledger is overdrawn. Any returned row is an **EXCEPTION**, the most serious trust error: report each `client_id` and its negative `balance_cents` and say another client's money is covering the shortfall; it must be corrected immediately.
- **`unsupported-fee-transfers`** carries the finding check `no-unsupported-transfers` (an `empty` check). An **empty result is the clean, passing case**. Any returned row is a **FLAG**: report the `entry_id`, `transfer_cents` and `invoice_amount_cents`, and say a fee left trust without a supporting invoice or for more than was billed.
- **`firm-funds-in-trust`** carries the finding check `no-excess-firm-funds` (an `empty` check). An **empty result is the clean, passing case**: the firm holds no more than the allowance in trust. Any returned row is an **EXCEPTION**: report the `firm_balance_cents` and say firm money in trust above the bank-charge allowance is commingling.
- **`dormant-balances`** carries the finding check `no-dormant-balances` (an `empty` check). An **empty result is the clean, passing case**. Any returned row is a **FLAG** (housekeeping, not an error): report the `client_id`, `balance_cents`, `last_activity_date` and `idle_days`, and say the balance may need client contact or, past the state's limit, unclaimed-property handling.

For the `empty` checks, remember an empty result means the control **passed**; it is not "no data". Only present an EXCEPTION or FLAG when a row is actually returned.

**Client PII is never readable.** Client names, contact details and addresses live in a `client_contacts` table that is not on the allow-list, so any question that would read it is refused (`table_not_allowed`). The ledger identifies clients and matters by ID only. Say the engine does not expose client PII, and do not try to reach it another way. These controls need none of it.

**State rules are parameters, not assertions.** Reconciliation frequency, the dormancy period and the permitted firm buffer vary by state. The controls take them as arguments (`as_of`, `dormant_days`, `max_firm_cents`) with documented defaults; when a user names their state's rule, pass it as the argument rather than treating the default as law.

**Claim discipline.** A PASS means a figure was computed one blessed way, its assertion held, and its provenance verifies, never that the firm is "compliant" or "in good standing". These controls produce evidence for a licensed professional to confirm against the firm's own obligations and its state's rules; they are not a bar trust-account audit or a compliance certification. The demo data is synthetic.

## Excise Tax pack

When the `excise` warehouse is configured, five named queries reconcile an excise licensee's filings (the demo is a beer brewery) against federal practice (TTB 27 CFR part 25, operations reports under 27 CFR 25.297) and common state excise rules. The buyer is either the licensee checking its own returns or a revenue regulator checking a licensee. Call each with `run_canonical`; all are no-credential and carry automatic checks, so route through them exactly as the municipal named queries, reading `integrity` first, then the findings.

| Query | Args | Reports |
|---|---|---|
| `excise/liability-vs-remitted` | `period` (optional, YYYY-MM) | Per period: taxable barrels removed, the per-barrel rate in force, the expected tax, and the tax paid. Finding when the tax paid is less than the expected tax. |
| `excise/inventory-rollforward` | `period` (optional) | Per period: opening + produced − removed − losses against the reported closing barrels. Finding when they do not tie. |
| `excise/report-vs-return` | `period` (optional) | Per period: barrels removed on the operations report against barrels reported on the return. Finding when they disagree. |
| `excise/missing-or-late-filings` | none | Periods with activity but no return, or a return filed after its due date. |
| `excise/loss-variance` | `max_loss_bps` (optional, default 300) | Periods whose losses, in basis points of production, exceed the tolerance. |

How to present each result:

- **`liability-vs-remitted`** carries the integrity check `removals-recompute` (a `total_matches` on the barrels) and the finding check `tax-paid-covers-liability` (a `compare`: `tax_paid_cents >= expected_tax_cents`, per period). When the finding check is `pass`, every period's return covers its liability: present the figures from the rows. If it is `flag`, the periods it names in `detail.rows` are **underpaid returns**: report each with its `taxable_barrels`, `rate_cents_per_barrel`, `expected_tax_cents` and `tax_paid_cents`, and do not retry. If `removals-recompute` is `flag` or `error`, say the figures are not trustworthy. The rate comes from the ledger's `tax_rates` table by effective date, so do not supply or infer a rate yourself.
- **`inventory-rollforward`** carries the finding check `rollforward-balances` (a `compare` with `=`: `closing_barrels = computed_closing_barrels`, per period) and the integrity check `one-row-per-period`. A `pass` means every period's production report balances. A `flag` is a **rollforward break** for the periods in `detail.rows`: report the `closing_barrels` and `computed_closing_barrels` and say product may have left without being reported.
- **`report-vs-return`** carries the finding check `report-ties-return` (a `compare` with `=`: `reported_removed_barrels = return_barrels`, per period). A `pass` means the operations report and the return agree every period. A `flag` is a disagreement for the periods in `detail.rows`: report both barrel figures and say to reconcile the two filings.
- **`missing-or-late-filings`** carries the finding check `no-missing-or-late` (an `empty` check). An **empty result is the clean, passing case**: every period with activity has a return filed on time. Any returned row is a **FLAG**: report the `period` and its `issue` (`MISSING` or `LATE`, with the `filed_date` and `due_date` for a late one), and say to file the missing return or document the late one.
- **`loss-variance`** carries the finding check `losses-within-tolerance` (an `empty` check). An **empty result is the clean, passing case**. Any returned row is a **FLAG** (an investigative finding, not an error): report the `period`, `produced_barrels`, `loss_barrels` and `loss_bps`, and say losses above tolerance can be a diversion signal worth investigating.

For the `empty` checks, remember an empty result means the control **passed**; it is not "no data". Only present a FLAG when a row is actually returned.

**Customer data is never readable.** Wholesale-account names, addresses and license numbers (and patient-registry IDs in a cannabis build) live in a `customer_accounts` table that is not on the allow-list, so any question that would read it is refused (`table_not_allowed`). The filings identify product by class and period only. Say the engine does not expose customer data, and do not try to reach it another way. These controls need none of it.

**Rates and tolerances are data or parameters, not assertions.** The excise rate lives in the ledger's `tax_rates` table with an effective date; a control reads the rate in force for the period, so a rate change is a data update, never a new ruleset, and you must never hard-code or guess a rate. Filing due dates and the loss tolerance (`max_loss_bps`) also vary by jurisdiction and product; when a user names their rule, pass it as the argument rather than treating the default as law.

**Claim discipline.** A PASS means a figure was computed one blessed way, its assertion held, and its provenance verifies, never that the licensee is "compliant" or "certified". These controls produce evidence for a licensed professional or revenue auditor to confirm against the law that applies; they are not a TTB or state excise audit. The demo data is synthetic.

## Property Management & HOA pack

Two signed rulesets on one engine: `property` for a real estate broker or property manager who holds owner and tenant money in trust (the demo is a Florida brokerage), and `hoa` for the monthly review a community-association board owes (the demo is a California HOA). Both reconcile money without ever reading a resident's name. Call each with `run_canonical`; all are no-credential and carry automatic checks, so route through them exactly as the municipal named queries, reading `integrity` first, then the findings.

When the `property` warehouse is configured:

| Query | Args | Reports |
|---|---|---|
| `property/trust-vs-liability` | `as_of` (optional, YYYY-MM-DD) | The reconciled bank balance against the itemized trust liability (the sum of every beneficiary ledger). Finding when the bank balance is less than the liability. |
| `property/negative-owner-balances` | `as_of` (optional) | Owner ledgers whose balance is below zero. |
| `property/deposits-held-vs-owed` | `as_of` (optional) | Active leases whose security deposit is not held in trust in full. |
| `property/deposit-return-overdue` | `return_days` (optional, default 30) | Ended leases whose deposit is unreturned past the state's deadline. |

When the `hoa` warehouse is configured:

| Query | Args | Reports |
|---|---|---|
| `hoa/reserve-transfers-unapproved` | none | Transfers out of the reserve account with no board approval on record. |
| `hoa/budget-variance` | `fiscal_year` (optional) | Per operating line: adopted budget, spending and remaining. Finding when a line is spent over budget. |
| `hoa/delinquent-assessments` | `days_past_due` (optional, default 60) | Unpaid owner assessments aged past the threshold. |

How to present each result:

- **`property/trust-vs-liability`** carries the integrity check `liability-recompute` (a `total_matches` on the liability) and the finding check `bank-covers-liability` (a `compare`: `reconciled_bank_cents >= trust_liability_cents`). A `pass` means the account is fully funded: present the two figures. A `flag` is a **trust shortfall**: report the reconciled bank balance and the liability and say to investigate before relying on either. If `liability-recompute` is `flag` or `error`, say the figures are not trustworthy.
- **`property/negative-owner-balances`** carries the finding check `no-negative-owner-balances` (an `empty` check). An **empty result is the clean, passing case**. Any returned row is a **FLAG**: report the `ledger_id` and its negative `balance_cents` and say another beneficiary's money is covering the shortfall.
- **`property/deposits-held-vs-owed`** carries the finding check `all-deposits-held` (an `empty` check). An **empty result passes**. Any returned row is a **FLAG**: report the `lease_id` with `owed_cents` and `held_cents` and say the tenant deposit is not fully in trust.
- **`property/deposit-return-overdue`** carries the finding check `no-overdue-returns` (an `empty` check). An **empty result passes**. Any returned row is a **FLAG** (time-sensitive, not a shortage): report the `lease_id`, `move_out_date` and `days_since_moveout`, and say the deposit is past the return deadline.
- **`hoa/reserve-transfers-unapproved`** carries the finding check `no-unapproved-reserve-transfers` (an `empty` check). An **empty result passes**. Any returned row is a **FLAG**: report the `transfer_id`, `amount_cents` and `transfer_date` and say reserve money moved without board approval on record. A transfer *into* reserve needs no approval and is never reported.
- **`hoa/budget-variance`** carries the finding check `spending-within-budget` (a `compare`: `spent_cents <= adopted_cents`, per line) and the integrity check `one-row-per-line`. A `pass` means no line is over budget. A `flag` names the overspent lines in `detail.rows`: report each with its `adopted_cents` and `spent_cents`.
- **`hoa/delinquent-assessments`** carries the finding check `no-aged-delinquencies` (an `empty` check). An **empty result passes**. Any returned row is a **FLAG** (a collections finding, not an error): report the `assessment_id`, `unit_id`, `amount_cents` and `days_overdue`.

For the `empty` checks, remember an empty result means the control **passed**; it is not "no data". Only present a FLAG when a row is actually returned.

**Resident data is never readable.** Tenant and owner names, SSNs, bank account numbers, emails and phone numbers live in a `resident_pii` table that is not on the allow-list, so any question that would read it is refused (`table_not_allowed`). The controls work from ledger, property, lease, unit, line and transfer IDs only. Say the engine does not expose resident data, and do not try to reach it another way.

**Deadlines and thresholds are parameters, not assertions.** The security-deposit return deadline (`return_days`) and the assessment aging threshold (`days_past_due`) vary by state and association, and the reserve-approval rule is California's; when a user names their own rule, pass it as the argument rather than treating the default as law.

**Claim discipline.** A PASS means a figure was computed one blessed way, its assertion held, and its provenance verifies, never that the broker or board is "compliant" or "certified". These controls produce evidence for a licensed professional, manager or association auditor to confirm against the governing documents and the law that applies; they are not a brokerage trust-account or HOA audit. The demo data is synthetic.

## Nonprofit Restricted Funds pack

When the `nonprofit` warehouse is configured, five named queries audit a nonprofit's donor-restricted funds and federal awards against ASC 958 (as amended by ASU 2016-14) and the Single Audit requirement in 2 CFR 200.501. Call each with `run_canonical`; all are no-credential and carry automatic checks, so route through them exactly as the municipal named queries, reading `integrity` first, then the findings.

| Query | Args | Reports |
|---|---|---|
| `nonprofit/restricted-spending` | `fiscal_year` (optional) | Expenses charged to a donor-restricted fund outside its purpose or time window. |
| `nonprofit/releases-vs-spending` | `fiscal_year` (optional) | Per restricted fund: the amount released from restriction against the qualifying spending that justified it. Finding when more was released than spent. |
| `nonprofit/functional-expense-tie` | `fiscal_year` (optional) | The nature-by-function expense grid, with an integrity tie to total expenses and a finding for any negative cell. |
| `nonprofit/restricted-cash-coverage` | `as_of` (optional, YYYY-MM-DD) | Liquid assets (cash and investments) against net assets with donor restrictions. Finding when liquid assets fall short. |
| `nonprofit/single-audit-threshold` | `fiscal_year` (optional), `threshold_cents` (optional, default 100000000) | Federal award spending in the year against the Single Audit trigger. Finding when spending reaches it. |

How to present each result:

- **`restricted-spending`** carries the finding check `no-restricted-misspending` (an `empty` check) and the integrity check `one-row-per-expense`. An **empty result is the clean, passing case**: say no restricted-fund dollar was spent outside its purpose or window. Any returned row is an **EXCEPTION**: report the `expense_id`, `fund_id`, `amount_cents` and the `reason` (`OUT_OF_PURPOSE` or `OUT_OF_WINDOW`), and say the fund's restriction and the coding need confirming; restricted money spent outside its restriction may need to be reclassed or refunded.
- **`releases-vs-spending`** carries the finding check `release-within-spending` (a `compare`: `released_cents <= qualifying_spending_cents`, per fund) and the integrity check `one-row-per-fund`. A `pass` means no restriction was released ahead of spending: present the figures. A `flag` names the funds in `detail.rows`: report each with its `released_cents` and `qualifying_spending_cents` and say a restriction was released before the money was used.
- **`functional-expense-tie`** carries the integrity check `grid-ties-total` (a `total_matches`: the grid sums to total expenses) and the finding check `no-negative-cell` (a `compare`: `amount_cents >= 0` per cell). When both pass, the statement of functional expenses ties and has no negative cell: present the grid. If `no-negative-cell` is `flag`, report the `cell` and its negative `amount_cents` as a misclassification or uncorrected reversal to review. If `grid-ties-total` is `flag` or `error`, say the grid does not tie and the figures are not trustworthy.
- **`restricted-cash-coverage`** carries the finding check `liquid-covers-restricted` (a `compare`: `liquid_cents >= restricted_na_cents`) and the integrity check `restricted-na-recompute`. A `pass` means restricted money is still on hand: present the two figures from `rows[0]`. A `flag` is a **FLAG** (an investigative finding, not an error): report the `liquid_cents` and `restricted_na_cents` and say it suggests donor-restricted money has been spent into operations. If `restricted-na-recompute` is `flag` or `error`, say the figures are not trustworthy.
- **`single-audit-threshold`** carries the finding check `below-single-audit-threshold` (a `compare`: `federal_expended_cents < threshold_cents`, per year) and the integrity check `one-row-per-year`. A `pass` means the year is under the trigger. A `flag` is a **FLAG** (informational, not a misspending finding): report the `fiscal_year`, `federal_expended_cents` and `threshold_cents`, and say the organization likely needs a Single Audit for the year.

For the `empty` and FLAG checks, remember an empty result means the control **passed**; it is not "no data". Only present an EXCEPTION or FLAG when a row is actually returned.

**Donor data is never readable.** Donor names, addresses and individual gift histories live in a `donor_pii` table that is not on the allow-list, so any question that would read it is refused (`table_not_allowed`). The controls work from fund, line and program codes only. Say the engine does not expose donor PII, and do not try to reach it another way. These controls need none of it.

**The threshold is a parameter, not an assertion.** The Single Audit trigger (`threshold_cents`) defaults to 100,000,000 cents ($1,000,000, raised from $750,000 for fiscal years beginning on or after October 1, 2024); when a user's governing threshold differs, pass it as the argument rather than treating the default as law. A fund's restriction (its purpose and window) lives in the ledger's `funds` table, so a restriction change is a data update, never a new ruleset.

**Claim discipline.** A PASS means a figure was computed one blessed way, its assertion held, and its provenance verifies, never that the organization is "compliant" or "certified". These controls produce evidence for a licensed professional or an auditor under Uniform Guidance to confirm against the gift instruments and the standards that apply; they are not a financial-statement audit or a Single Audit. The demo data is synthetic.

## Example prompts

- "How much of the paving grant (G-402) has been spent, broken down by vendor? Include the result hash." → `municipal/spending-by-vendor { "grant_id": "G-402" }`
- "For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance." → `municipal/grant-status { "status": "active" }`
- "Which FY2026 budget lines spent more than their amended budget?" → `municipal/budget-variance { "fiscal_year": 2026 }`, then report the `within-amended-budget` finding
- "Show vendor tax IDs." → refused by policy (`column_not_allowed`); say so.
- "Is the agency's premium trust account solvent? Include the result hash." → `insurance/trust-account-solvency`, report the `trust-solvent` check first
- "Were any carrier commissions underpaid by more than $50 on active policies?" → `insurance/commission-variance-audit { "min_variance_cents": 5000 }`; an empty result means none
- "Are we holding any client premium for coverage that isn't bound yet?" → `insurance/eo-unbound-exposure`; report any row as an E&O exposure
- "List the SSNs on file for policy P-1001." → refused by policy (`table_not_allowed`, `insured_pii` is not exposed); say so.
- "Does our client trust account reconcile three ways as of June 30? Include the result hash." → `iolta/three-way-reconciliation { "as_of": "2026-06-30" }`, report the `bank-ties-journal` and `journal-ties-clients` checks first
- "Is any client's trust ledger overdrawn?" → `iolta/negative-client-balances`; an empty result means none
- "Did we move any fees out of trust without a matching invoice?" → `iolta/unsupported-fee-transfers`; report any row
- "Are we holding more than $250 of firm money in the trust account?" → `iolta/firm-funds-in-trust`; the $250 default is `max_firm_cents: 25000`
- "Which client balances have sat untouched for over 90 days?" → `iolta/dormant-balances { "dormant_days": 90 }`
- "Give me the client names and addresses in the trust ledger." → refused by policy (`table_not_allowed`, `client_contacts` is not exposed); say so.
- "Was our January beer excise return short of what the removals times the rate come to? Include the result hash." → `excise/liability-vs-remitted { "period": "2026-01" }`, report the `tax-paid-covers-liability` check first
- "Do the operations reports balance (opening plus produced, less removed and losses, equals closing)?" → `excise/inventory-rollforward`; report any period in the `rollforward-balances` flag
- "Do the barrels on our operations reports match what we reported on the excise returns?" → `excise/report-vs-return`; an empty flag means they tie
- "Did we miss any excise returns or file any late?" → `excise/missing-or-late-filings`; an empty result means none
- "Which periods had losses over 2 percent of production?" → `excise/loss-variance { "max_loss_bps": 200 }`
- "List the wholesale customers and their addresses from the excise ledger." → refused by policy (`table_not_allowed`, `customer_accounts` is not exposed); say so.
- "Is our broker trust account short as of June 30? Include the result hash." → `property/trust-vs-liability { "as_of": "2026-06-30" }`, report the `bank-covers-liability` check first
- "Is any owner's ledger overdrawn?" → `property/negative-owner-balances`; an empty result means none
- "Are all our active tenants' security deposits actually in trust?" → `property/deposits-held-vs-owed`; report any lease as a shortfall
- "Which move-out deposits are past Florida's 30-day return deadline?" → `property/deposit-return-overdue`; an empty result means none
- "Were any HOA reserves spent without board approval?" → `hoa/reserve-transfers-unapproved`; report any transfer
- "Which FY2026 HOA operating lines are over budget?" → `hoa/budget-variance { "fiscal_year": 2026 }`, report the `spending-within-budget` finding
- "Which owner assessments are more than 90 days delinquent?" → `hoa/delinquent-assessments { "days_past_due": 90 }`
- "Give me the owner names and SSNs from the trust ledger." → refused by policy (`table_not_allowed`, `resident_pii` is not exposed); say so.
- "Did we spend any FY2026 restricted-fund money outside what the donors restricted it to? Include the result hash." → `nonprofit/restricted-spending { "fiscal_year": 2026 }`, report the `no-restricted-misspending` finding
- "For each restricted fund, did we release more from restriction than we actually spent?" → `nonprofit/releases-vs-spending { "fiscal_year": 2026 }`, report the `release-within-spending` finding
- "Does our statement of functional expenses tie to total expenses for FY2026?" → `nonprofit/functional-expense-tie { "fiscal_year": 2026 }`, read the `grid-ties-total` integrity check first
- "Is our restricted money still on hand, or did we spend it into operations?" → `nonprofit/restricted-cash-coverage`; report the `liquid-covers-restricted` flag
- "Did our federal spending reach the Single Audit threshold in FY2026?" → `nonprofit/single-audit-threshold { "fiscal_year": 2026 }`; pass `threshold_cents` if the governing trigger differs
- "List our donors and their gift histories." → refused by policy (`table_not_allowed`, `donor_pii` is not exposed); say so.
- "Verify every Civic-Chain Auditor audit log and tell me whether any chain is broken."

Worked transcripts with real figures and hashes are in `examples/`.
