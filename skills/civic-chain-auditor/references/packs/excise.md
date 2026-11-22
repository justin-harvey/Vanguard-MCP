# Excise Tax pack

Configured as the `excise` warehouse (demo is a beer brewery). Reconciles an excise licensee's
filings against federal practice (TTB 27 CFR part 25, operations reports under 27 CFR 25.297) and
common state excise rules. The buyer is the licensee checking its own returns or a revenue
regulator checking a licensee. Use for: returns short of liability, inventory rollforward breaks,
operations report vs return disagreements, missing or late filings, losses over tolerance.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `excise/liability-vs-remitted` | `period` (optional, YYYY-MM) | Per period: taxable barrels removed, the per-barrel rate in force, expected tax, tax paid. Finding when tax paid is less than expected. |
| `excise/inventory-rollforward` | `period` (optional) | Per period: opening + produced − removed − losses against reported closing barrels. Finding when they do not tie. |
| `excise/report-vs-return` | `period` (optional) | Per period: barrels removed on the operations report against barrels on the return. Finding when they disagree. |
| `excise/missing-or-late-filings` | none | Periods with activity but no return, or a return filed late. |
| `excise/loss-variance` | `max_loss_bps` (optional, default 300) | Periods whose losses, in basis points of production, exceed tolerance. |

- **`liability-vs-remitted`** carries integrity check `removals-recompute` (`total_matches`) and
  finding check `tax-paid-covers-liability` (`compare`: `tax_paid_cents >= expected_tax_cents`,
  per period). `pass` → every return covers its liability. `flag` → the periods in `detail.rows`
  are **underpaid returns**: report `taxable_barrels`, `rate_cents_per_barrel`, `expected_tax_cents`
  and `tax_paid_cents`. If `removals-recompute` is `flag`/`error`, say the figures are not
  trustworthy. The rate comes from the ledger's `tax_rates` table by effective date — never supply
  or infer a rate yourself.
- **`inventory-rollforward`** — finding check `rollforward-balances` (`compare` `=`:
  `closing_barrels = computed_closing_barrels`) + integrity `one-row-per-period`. A `flag` is a
  **rollforward break**: report `closing_barrels` and `computed_closing_barrels`; product may have
  left without being reported.
- **`report-vs-return`** — finding check `report-ties-return` (`compare` `=`). A `flag` is a
  disagreement: report both barrel figures; reconcile the two filings.
- **`missing-or-late-filings`** — `empty` check `no-missing-or-late`. Any row is a **FLAG**:
  report the `period` and its `issue` (`MISSING`, or `LATE` with `filed_date`/`due_date`).
- **`loss-variance`** — `empty` check `losses-within-tolerance`. Any row is a **FLAG**
  (investigative): report `period`, `produced_barrels`, `loss_barrels`, `loss_bps`; losses above
  tolerance can be a diversion signal.

**Rates and tolerances are data or parameters, not assertions.** The rate lives in `tax_rates`
with an effective date, so a rate change is a data update, never a new ruleset. Due dates and
`max_loss_bps` vary by jurisdiction; pass the user's rule as an argument.

**PII:** wholesale-account names, addresses and license numbers (and patient-registry IDs in a
cannabis build) live in `customer_accounts` (not on the allow-list); reads are refused
(`table_not_allowed`). Not a TTB or state excise audit; the demo data is synthetic.

## Example prompts
- "Was our January beer excise return short of what the removals times the rate come to? Include the result hash." → `excise/liability-vs-remitted { "period": "2026-01" }`, report the `tax-paid-covers-liability` check first
- "Do the operations reports balance (opening plus produced, less removed and losses, equals closing)?" → `excise/inventory-rollforward`; report any period in the `rollforward-balances` flag
- "Do the barrels on our operations reports match what we reported on the excise returns?" → `excise/report-vs-return`; an empty flag means they tie
- "Did we miss any excise returns or file any late?" → `excise/missing-or-late-filings`; an empty result means none
- "Which periods had losses over 2 percent of production?" → `excise/loss-variance { "max_loss_bps": 200 }`
- "List the wholesale customers and their addresses from the excise ledger." → refused by policy (`table_not_allowed`, `customer_accounts` is not exposed); say so.
