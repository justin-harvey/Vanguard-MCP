# School Districts pack

Configured as the `schools` warehouse. Audits student activity funds, federal program costs and
budget against GASB Statement No. 84 (student activity money held in a custodial capacity is a
fiduciary fund), the 2 CFR 200 period-of-performance requirement, and budget-versus-actual review.
Use for: overdrawn activity accounts, activity cash deposited late, disbursements without the
required approvals, federal costs outside the award period, overspent budget lines.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `schools/activity-negative-balances` | `as_of` (optional, YYYY-MM-DD) | Student activity accounts whose collections do not cover disbursements (overdrawn custodial funds). |
| `schools/activity-deposits-late` | `deposit_days` (optional, default 1) | Activity cash deposited more than `deposit_days` after collection, or not deposited. |
| `schools/activity-unapproved-disbursements` | none | Activity disbursements missing the advisor or the principal approval. |
| `schools/federal-outside-period` | `fiscal_year` (optional) | Federal program costs charged outside the award's period of performance. |
| `schools/budget-variance` | `fiscal_year` (optional) | Budget lines whose paid spending exceeds their amended budget. |

- **`activity-negative-balances`** — `empty` check `no-negative-activity-balance` + integrity
  `one-row-per-account`. Any row is an **EXCEPTION**: report `account_id`, `account_name` and
  negative `balance_cents` (with `collected_cents`, `disbursed_cents`); the custodial fund has
  spent money it has not collected.
- **`activity-deposits-late`** — `empty` check `deposits-prompt` + integrity
  `one-row-per-collection`. A `flag` is a **FLAG** (investigative): report each `collection_id`
  with its `reason` (`LATE` with `days_to_deposit`, or `UNDEPOSITED`).
- **`activity-unapproved-disbursements`** — `empty` check `disbursements-approved` + integrity
  `one-row-per-disbursement`. Any row is an **EXCEPTION**: report `disbursement_id`, `account_id`,
  `amount_cents` and `reason` (`MISSING_ADVISOR` / `MISSING_PRINCIPAL` / `MISSING_BOTH`).
- **`federal-outside-period`** — `empty` check `costs-within-period` + integrity `one-row-per-cost`.
  Any row is an **EXCEPTION**: report `cost_id`, `program_name`, `charge_date`, the program's
  `period_start`/`period_end` and `reason` (`BEFORE_PERIOD` / `AFTER_PERIOD`); the cost may be
  unallowable and need to be moved or refunded.
- **`budget-variance`** — finding `within-amended-budget` (`compare`:
  `paid_cents <= amended_cents`) + integrity `one-row-per-line` and `paid-total-reconciles`. Read
  the integrity checks first; if `paid-total-reconciles` is `flag`/`error`, say the figures are not
  trustworthy. A `flag` names the overspent lines: report `paid_cents` and `amended_cents`.

**The deposit window and approval rule are the district's, not the engine's.** `deposit_days`
defaults to 1 (one business day); pass the district's policy if it differs. The
advisor-plus-principal rule is read from the ledger's `advisor_approved`/`principal_approved`
flags, so a correction is a data update, never a new ruleset.

**PII:** student names, grade levels and meal-eligibility status live in `student_records` (not on
the allow-list, withheld under FERPA); reads are refused (`table_not_allowed`). Not a
financial-statement audit or a Single Audit; the demo data is synthetic.

## Example prompts
- "Is any student club or class account overdrawn? Include the result hash." → `schools/activity-negative-balances`; an empty result means none
- "Was any activity cash held more than a day before it was deposited?" → `schools/activity-deposits-late { "deposit_days": 1 }`; report any row as a FLAG
- "Did we pay anything out of an activity account without the required approvals?" → `schools/activity-unapproved-disbursements`; report any row with its `reason`
- "Were any Title I or IDEA costs charged outside the award period in FY2026?" → `schools/federal-outside-period { "fiscal_year": 2026 }`; an empty result means none
- "Which FY2026 school budget lines are over their amended budget?" → `schools/budget-variance { "fiscal_year": 2026 }`, report the `within-amended-budget` finding
- "Show me the students on free or reduced lunch." → refused by policy (`table_not_allowed`, `student_records` is not exposed under FERPA); say so.
