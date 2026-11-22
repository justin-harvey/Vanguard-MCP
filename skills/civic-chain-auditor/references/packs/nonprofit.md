# Nonprofit Restricted Funds pack

Configured as the `nonprofit` warehouse. Audits donor-restricted funds and federal awards against
ASC 958 (as amended by ASU 2016-14) and the Single Audit requirement in 2 CFR 200.501. Use for:
restricted money spent outside its purpose or window, restriction released ahead of spending,
statement of functional expenses tie-out, restricted cash coverage, Single Audit threshold.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `nonprofit/restricted-spending` | `fiscal_year` (optional) | Expenses charged to a donor-restricted fund outside its purpose or time window. |
| `nonprofit/releases-vs-spending` | `fiscal_year` (optional) | Per fund: amount released from restriction against the qualifying spending. Finding when more was released than spent. |
| `nonprofit/functional-expense-tie` | `fiscal_year` (optional) | The nature-by-function expense grid, with an integrity tie to total expenses and a finding for any negative cell. |
| `nonprofit/restricted-cash-coverage` | `as_of` (optional, YYYY-MM-DD) | Liquid assets against net assets with donor restrictions. Finding when liquid assets fall short. |
| `nonprofit/single-audit-threshold` | `fiscal_year` (optional), `threshold_cents` (optional, default 100000000) | Federal award spending against the Single Audit trigger. Finding when spending reaches it. |

- **`restricted-spending`** — `empty` check `no-restricted-misspending` + integrity
  `one-row-per-expense`. Any row is an **EXCEPTION**: report `expense_id`, `fund_id`,
  `amount_cents` and `reason` (`OUT_OF_PURPOSE` / `OUT_OF_WINDOW`); the restriction and coding need
  confirming; may need reclass or refund.
- **`releases-vs-spending`** — finding `release-within-spending` (`compare`:
  `released_cents <= qualifying_spending_cents`) + integrity `one-row-per-fund`. A `flag` names the
  funds: report `released_cents` and `qualifying_spending_cents`; a restriction was released before
  the money was used.
- **`functional-expense-tie`** — integrity `grid-ties-total` (`total_matches`) + finding
  `no-negative-cell` (`compare`: `amount_cents >= 0`). Both pass → the statement ties; present the
  grid. `no-negative-cell` `flag` → report the `cell` and negative `amount_cents`. If
  `grid-ties-total` is `flag`/`error`, say the grid does not tie and the figures are not
  trustworthy.
- **`restricted-cash-coverage`** — finding `liquid-covers-restricted` (`compare`:
  `liquid_cents >= restricted_na_cents`) + integrity `restricted-na-recompute`. A `flag` is a
  **FLAG** (investigative): report `liquid_cents` and `restricted_na_cents`; suggests restricted
  money was spent into operations. If `restricted-na-recompute` is `flag`/`error`, say the figures
  are not trustworthy.
- **`single-audit-threshold`** — finding `below-single-audit-threshold` (`compare`:
  `federal_expended_cents < threshold_cents`) + integrity `one-row-per-year`. A `flag` is a **FLAG**
  (informational): report `fiscal_year`, `federal_expended_cents`, `threshold_cents`; the
  organization likely needs a Single Audit for the year.

**The threshold is a parameter, not an assertion.** `threshold_cents` defaults to 100,000,000
cents ($1,000,000, raised from $750,000 for fiscal years beginning on or after October 1, 2024);
pass the governing threshold if it differs. A fund's restriction lives in the `funds` table, so a
restriction change is a data update, never a new ruleset.

**PII:** donor names, addresses and gift histories live in `donor_pii` (not on the allow-list);
reads are refused (`table_not_allowed`). Not a financial-statement audit or a Single Audit; the
demo data is synthetic.

## Example prompts
- "Did we spend any FY2026 restricted-fund money outside what the donors restricted it to? Include the result hash." → `nonprofit/restricted-spending { "fiscal_year": 2026 }`, report the `no-restricted-misspending` finding
- "For each restricted fund, did we release more from restriction than we actually spent?" → `nonprofit/releases-vs-spending { "fiscal_year": 2026 }`, report the `release-within-spending` finding
- "Does our statement of functional expenses tie to total expenses for FY2026?" → `nonprofit/functional-expense-tie { "fiscal_year": 2026 }`, read the `grid-ties-total` integrity check first
- "Is our restricted money still on hand, or did we spend it into operations?" → `nonprofit/restricted-cash-coverage`; report the `liquid-covers-restricted` flag
- "Did our federal spending reach the Single Audit threshold in FY2026?" → `nonprofit/single-audit-threshold { "fiscal_year": 2026 }`; pass `threshold_cents` if the governing trigger differs
- "List our donors and their gift histories." → refused by policy (`table_not_allowed`, `donor_pii` is not exposed); say so.
