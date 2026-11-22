# Law Firm Trust (IOLTA) pack

Configured as the `iolta` warehouse. Audits a law firm's client trust account against ABA Model
Rule 1.15 and common reconciliation practice. Use for: three-way reconciliation, overdrawn client
ledgers, unsupported fee transfers, firm money commingled in trust, dormant client balances.

Route through `run_canonical` first; read the shared rules in SKILL.md ("Reading a pack result"
and "Claim discipline and PII") before presenting.

| Query | Args | Reports |
|---|---|---|
| `iolta/three-way-reconciliation` | `as_of` (optional, YYYY-MM-DD) | Adjusted bank balance, trust journal balance, and the sum of the client ledgers. Findings when the three do not tie. |
| `iolta/negative-client-balances` | `as_of` (optional) | Client ledgers below zero. |
| `iolta/unsupported-fee-transfers` | none | Earned-fee transfers out of trust with no invoice, or larger than the invoice. |
| `iolta/firm-funds-in-trust` | `max_firm_cents` (optional, default 25000) | Firm money held in trust above the bank-charge allowance (commingling). |
| `iolta/dormant-balances` | `dormant_days` (optional, default 365) | Client ledgers idle with a positive balance past the threshold. |

- **`three-way-reconciliation`** carries the integrity check `client-ledgers-recompute`
  (`total_matches`) and two `compare` (`=`) finding checks: `bank-ties-journal` and
  `journal-ties-clients`. Both `pass` → the account reconciles; present the three figures from
  `rows[0]`. Either `flag` → a **reconciliation break**: report which tie failed and the two
  figures. If `client-ledgers-recompute` is `flag`/`error`, say the figures are not trustworthy.
- **`negative-client-balances`** — `empty` check `no-negative-balances`. Empty = clean. Any row
  is an **EXCEPTION** (the most serious trust error): report the `client_id` and negative
  `balance_cents`; another client's money is covering the shortfall; correct immediately.
- **`unsupported-fee-transfers`** — `empty` check `no-unsupported-transfers`. Any row is a
  **FLAG**: report `entry_id`, `transfer_cents` and `invoice_amount_cents`.
- **`firm-funds-in-trust`** — `empty` check `no-excess-firm-funds`. Any row is an **EXCEPTION**:
  report `firm_balance_cents`; firm money above the allowance is commingling.
- **`dormant-balances`** — `empty` check `no-dormant-balances`. Any row is a **FLAG**
  (housekeeping): report `client_id`, `balance_cents`, `last_activity_date`, `idle_days`; may need
  client contact or unclaimed-property handling.

**State rules are parameters, not assertions.** Reconciliation frequency, dormancy period and the
permitted firm buffer vary by state; pass `as_of`, `dormant_days`, `max_firm_cents` when the user
names their rule rather than treating the default as law.

**PII:** client names, contacts and addresses live in `client_contacts` (not on the allow-list);
reads are refused (`table_not_allowed`). The ledger uses client and matter IDs only. Not a bar
trust-account audit or a compliance certification; the demo data is synthetic.

## Example prompts
- "Does our client trust account reconcile three ways as of June 30? Include the result hash." → `iolta/three-way-reconciliation { "as_of": "2026-06-30" }`, report the `bank-ties-journal` and `journal-ties-clients` checks first
- "Is any client's trust ledger overdrawn?" → `iolta/negative-client-balances`; an empty result means none
- "Did we move any fees out of trust without a matching invoice?" → `iolta/unsupported-fee-transfers`; report any row
- "Are we holding more than $250 of firm money in the trust account?" → `iolta/firm-funds-in-trust { "max_firm_cents": 25000 }`
- "Which client balances have sat untouched for over 90 days?" → `iolta/dormant-balances { "dormant_days": 90 }`
- "Give me the client names and addresses in the trust ledger." → refused by policy (`table_not_allowed`, `client_contacts` is not exposed); say so.
