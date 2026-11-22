# Municipal Grants & Budgets pack

Configured as the `municipal` warehouse. Audits a town or public body's grant spending,
budget variance, vendor payments and drawdowns. Use for: how much of a grant has been spent,
spending broken down by vendor, grant drawdowns against expenditures, overspent budget lines,
cash drawn ahead of spending, closed grants with award left unspent.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `municipal/grant-status` | `status` (optional), `grant_id` (optional) | Per grant: award, paid expenditures, cash drawn down, remaining balance. |
| `municipal/spending-by-vendor` | `grant_id` (optional) | Paid spending grouped by vendor. |
| `municipal/budget-variance` | `fiscal_year` (optional) | Per budget line: amended budget, paid spending, remaining. Finding when a line is overspent. |

**`budget-variance`** carries the finding check `within-amended-budget` (a `compare`:
`paid_cents <= amended_cents`, per line) and the integrity checks `one-row-per-line` and
`paid-total-reconciles`. Read the integrity checks first: if `paid-total-reconciles` is `flag`
or `error`, say the figures are not trustworthy. A `flag` on `within-amended-budget` names the
overspent lines in `detail.rows`; report each with its `paid_cents` and `amended_cents`.

**`grant-status`** reports the drawdown picture; a grant whose drawn cash exceeds paid
expenditures is cash drawn ahead of spending, a finding worth calling out. **`spending-by-vendor`**
is a breakdown, not a finding.

"Spent" means `status = 'paid'`; `void` rows never count; spending is compared against
`amended_cents`.

**PII:** the `payroll` table and the vendor tax-ID and bank-account columns are withheld (not on
the allow-list); a question that reads them is refused (`table_not_allowed` / `column_not_allowed`).
Not a budget audit or an opinion; the demo data is synthetic.

## Example prompts
- "How much of the paving grant (G-402) has been spent, broken down by vendor? Include the result hash." → `municipal/spending-by-vendor { "grant_id": "G-402" }`
- "For every active grant, show the award, paid expenditures, cash drawn down, and remaining balance." → `municipal/grant-status { "status": "active" }`
- "Which FY2026 budget lines spent more than their amended budget?" → `municipal/budget-variance { "fiscal_year": 2026 }`, then report the `within-amended-budget` finding
- "Show vendor tax IDs." → refused by policy (`column_not_allowed`); say so.
