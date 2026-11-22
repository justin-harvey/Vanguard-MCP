# Insurance & Fiduciary pack

Configured as the `insurance` warehouse (demo is a Florida-style agency). Reconciles an
agency's premium trust. Use for: is the premium trust solvent, carrier commission variances
or errors, errors-and-omissions exposure on unbound policies.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `insurance/trust-account-solvency` | none | Premiums collected, carrier remittances, commission drawn, the net trust liability, and the latest actual bank balance. Finding when the balance does not cover the liability. |
| `insurance/commission-variance-audit` | `min_variance_cents` (optional, default 100) | Active or bound policies whose received commission varies from the contracted rate by more than the threshold. |
| `insurance/eo-unbound-exposure` | none | Policies holding client premium with no carrier-confirmed binder. |

- **`trust-account-solvency`** carries the finding check `trust-solvent` (a `compare`:
  `bank_balance_cents >= net_trust_liability_cents`). `pass` means solvent; present the figures.
  `flag` is an **EXCEPTION** (fiduciary trust shortfall): report the net liability and the bank
  balance from `rows[0]` using the check's `message`. The integrity check `collected-reconciles`
  confirms the premium total; if it is `flag` or `error`, say the figures are not trustworthy.
- **`commission-variance-audit`** carries the `empty` finding check `no-commission-variance`.
  Empty = clean (every active policy paid as contracted). Any row is a **FLAG**: report the
  `policy_id`, `expected_comm_cents`, `actual_paid_cents` and `variance_cents`; a negative
  variance is an underpayment, a positive one an overpayment or missed chargeback. Say to review
  the carrier statements before any producer payout.
- **`eo-unbound-exposure`** carries the `empty` finding check `no-unbound-premium`. Empty = clean.
  Any row is an **EXCEPTION**: report the `policy_id` and `client_funds_held_cents` as an
  immediate E&O exposure; confirm the binder or return the premium.

**PII:** SSNs and health data live in `insured_pii` (not on the allow-list); reads are refused
(`table_not_allowed` / `column_not_allowed`). Not a department-of-insurance audit or an E&O
coverage opinion; the demo data is synthetic.

## Example prompts
- "Is the agency's premium trust account solvent? Include the result hash." → `insurance/trust-account-solvency`, report the `trust-solvent` check first
- "Were any carrier commissions underpaid by more than $50 on active policies?" → `insurance/commission-variance-audit { "min_variance_cents": 5000 }`; an empty result means none
- "Are we holding any client premium for coverage that isn't bound yet?" → `insurance/eo-unbound-exposure`; report any row as an E&O exposure
- "List the SSNs on file for policy P-1001." → refused by policy (`table_not_allowed`, `insured_pii` is not exposed); say so.
