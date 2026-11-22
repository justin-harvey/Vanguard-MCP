# Construction Contracts pack

Configured as the `construction` warehouse. Audits a contractor's work-in-progress (WIP) schedule
against ASC 606 over-time (cost-to-cost) revenue recognition. Use for: the WIP schedule and its
tie to the general ledger, over- and underbillings and their tie to the balance sheet, loss jobs,
margin fade, retainage, subcontractor lien waivers.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `construction/wip-schedule` | `as_of` (optional, label only) | Per job: contract value, estimated cost, cost to date, percent complete (bps), earned revenue, billings, over/underbilling. |
| `construction/billings-tie-out` | none | Total over- and underbillings against the contract liability and contract asset on the balance sheet. |
| `construction/loss-jobs` | `as_of` (optional, label only) | Jobs whose estimated cost at completion exceeds the contract value. |
| `construction/margin-fade` | `fade_bps` (optional, default 300) | Jobs whose estimated gross margin fell more than `fade_bps` since the last WIP snapshot. |
| `construction/retainage-reconciles` | none | Jobs whose carried retainage receivable does not equal withheld less released. |
| `construction/payments-without-lien-waiver` | none | Subcontractor payments released with no lien waiver on file. |

- **`wip-schedule`** — integrity checks `one-row-per-job` and `earned-ties-gl` (`total_matches`:
  earned-revenue total = GL revenue). Read them first; if `earned-ties-gl` is `flag`/`error`, say
  the schedule does not tie to the books and the figures are not trustworthy. On a clean tie,
  present the per-job rows (`earned_revenue_cents`, `percent_complete_bps`, `overbilling_cents` or
  `underbilling_cents`). No finding check; it is the schedule itself.
- **`billings-tie-out`** — two `compare` (`=`) finding checks, `overbillings-tie-liability` and
  `underbillings-tie-asset`. A `flag` on either is an **EXCEPTION**: report `overbillings_cents` /
  `underbillings_cents` against `contract_liability_cents` / `contract_asset_cents`; the balance
  sheet is misstated.
- **`loss-jobs`** — `empty` check `no-loss-jobs` + integrity `one-row-per-loss-job`. Any row is an
  **EXCEPTION**: report `job_id`, `job_name`, `contract_value_cents`, `estimated_cost_cents`,
  `estimated_loss_cents`; the full estimated loss should already be recognized under ASC 606.
- **`margin-fade`** — `empty` check `margin-holds` + integrity `one-row-per-faded-job`. A `flag` is
  a **FLAG** (investigative): report `job_id`, `current_margin_bps`, `prior_margin_bps`, `fade_bps`.
- **`retainage-reconciles`** — finding `receivable-ties` (`compare`:
  `receivable_cents = expected_receivable_cents`) + integrity `one-row-per-job`. A `flag` names the
  jobs: report `withheld_cents`, `released_cents`, `receivable_cents`; retainage that does not
  reconcile is lost or double counted.
- **`payments-without-lien-waiver`** — `empty` check `waivers-on-file` + integrity
  `one-row-per-payment`. Any row is an **EXCEPTION**: report `payment_id`, `job_id`,
  `subcontractor_id`, `amount_cents`; a mechanic's-lien exposure.

**Percent complete and the fade window are the firm's data, not the engine's.** Percent complete
and margin are integer basis points computed from the `jobs` figures, so a corrected estimate is a
data update, never a new ruleset. `fade_bps` defaults to 300 (a 3-point fall); pass a surety's or
lender's threshold if it differs.

**PII:** employee names, SSNs, hourly pay rates and certified-payroll classifications live in
`payroll_pii` (not on the allow-list); reads are refused (`table_not_allowed`). Not a
financial-statement audit; the demo data is synthetic.

## Example prompts
- "Show me our work-in-progress schedule and confirm earned revenue ties to the general ledger. Include the result hash." → `construction/wip-schedule`, read the `earned-ties-gl` integrity check first
- "Do our over- and underbillings tie to the balance sheet?" → `construction/billings-tie-out`; report any `flag` as a balance-sheet misstatement
- "Is any job headed for a loss?" → `construction/loss-jobs`; an empty result means none
- "Which jobs have faded more than 3 points in margin since last quarter?" → `construction/margin-fade { "fade_bps": 300 }`; report each row as a FLAG
- "Does our retainage receivable reconcile to withheld less released?" → `construction/retainage-reconciles`; report any job in the `receivable-ties` flag
- "Did we pay any subcontractor without a lien waiver on file?" → `construction/payments-without-lien-waiver`; report any row
- "Give me the certified-payroll rates and SSNs for the crew." → refused by policy (`table_not_allowed`, `payroll_pii` is not exposed); say so.
