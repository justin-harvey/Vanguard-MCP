# Property Management & HOA pack

Two signed rulesets on one engine: `property` for a real estate broker or property manager who
holds owner and tenant money in trust (demo is a Florida brokerage), and `hoa` for the monthly
review a community-association board owes (demo is a California HOA). Use for: broker trust
shortfalls, overdrawn owner ledgers, security deposits not held or returned late, unapproved HOA
reserve transfers, HOA budget variance, delinquent assessments.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

When the `property` warehouse is configured:

| Query | Args | Reports |
|---|---|---|
| `property/trust-vs-liability` | `as_of` (optional, YYYY-MM-DD) | Reconciled bank balance against the itemized trust liability. Finding when the bank balance is less than the liability. |
| `property/negative-owner-balances` | `as_of` (optional) | Owner ledgers below zero. |
| `property/deposits-held-vs-owed` | `as_of` (optional) | Active leases whose security deposit is not held in trust in full. |
| `property/deposit-return-overdue` | `return_days` (optional, default 30) | Ended leases whose deposit is unreturned past the deadline. |

When the `hoa` warehouse is configured:

| Query | Args | Reports |
|---|---|---|
| `hoa/reserve-transfers-unapproved` | none | Transfers out of reserve with no board approval on record. |
| `hoa/budget-variance` | `fiscal_year` (optional) | Per operating line: adopted budget, spending, remaining. Finding when a line is over budget. |
| `hoa/delinquent-assessments` | `days_past_due` (optional, default 60) | Unpaid owner assessments aged past the threshold. |

- **`property/trust-vs-liability`** — integrity `liability-recompute` (`total_matches`) + finding
  `bank-covers-liability` (`compare`: `reconciled_bank_cents >= trust_liability_cents`). `flag` is
  a **trust shortfall**: report the reconciled bank balance and the liability. If
  `liability-recompute` is `flag`/`error`, say the figures are not trustworthy.
- **`property/negative-owner-balances`** — `empty` check `no-negative-owner-balances`. Any row is a
  **FLAG**: report `ledger_id` and negative `balance_cents`.
- **`property/deposits-held-vs-owed`** — `empty` check `all-deposits-held`. Any row is a **FLAG**:
  report `lease_id`, `owed_cents`, `held_cents`.
- **`property/deposit-return-overdue`** — `empty` check `no-overdue-returns`. Any row is a **FLAG**
  (time-sensitive): report `lease_id`, `move_out_date`, `days_since_moveout`.
- **`hoa/reserve-transfers-unapproved`** — `empty` check `no-unapproved-reserve-transfers`. Any row
  is a **FLAG**: report `transfer_id`, `amount_cents`, `transfer_date`. A transfer *into* reserve
  needs no approval and is never reported.
- **`hoa/budget-variance`** — finding `spending-within-budget` (`compare`:
  `spent_cents <= adopted_cents`) + integrity `one-row-per-line`. A `flag` names the overspent
  lines: report `adopted_cents` and `spent_cents`.
- **`hoa/delinquent-assessments`** — `empty` check `no-aged-delinquencies`. Any row is a **FLAG**
  (collections): report `assessment_id`, `unit_id`, `amount_cents`, `days_overdue`.

**Deadlines and thresholds are parameters, not assertions.** `return_days` and `days_past_due`
vary by state and association, and the reserve-approval rule is California's; pass the user's rule
as an argument.

**PII:** tenant and owner names, SSNs, bank accounts, emails and phones live in `resident_pii`
(not on the allow-list); reads are refused (`table_not_allowed`). Not a brokerage trust-account or
HOA audit; the demo data is synthetic.

## Example prompts
- "Is our broker trust account short as of June 30? Include the result hash." → `property/trust-vs-liability { "as_of": "2026-06-30" }`, report the `bank-covers-liability` check first
- "Is any owner's ledger overdrawn?" → `property/negative-owner-balances`; an empty result means none
- "Are all our active tenants' security deposits actually in trust?" → `property/deposits-held-vs-owed`; report any lease as a shortfall
- "Which move-out deposits are past Florida's 30-day return deadline?" → `property/deposit-return-overdue`; an empty result means none
- "Were any HOA reserves spent without board approval?" → `hoa/reserve-transfers-unapproved`; report any transfer
- "Which FY2026 HOA operating lines are over budget?" → `hoa/budget-variance { "fiscal_year": 2026 }`, report the `spending-within-budget` finding
- "Which owner assessments are more than 90 days delinquent?" → `hoa/delinquent-assessments { "days_past_due": 90 }`
- "Give me the owner names and SSNs from the trust ledger." → refused by policy (`table_not_allowed`, `resident_pii` is not exposed); say so.
