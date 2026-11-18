# Example: a short broker trust account (EXCEPTION)

The agent runs the Property Management & HOA pack's broker-trust reconciliation and surfaces a trust account holding less than the broker owes to owners and tenants. Every figure comes from the tool result; the agent does no arithmetic of its own. Figures and hashes below are from a demo log in which the latest bank statement was deliberately lowered, to show the EXCEPTION path; the shipped demo seed is clean and reads PASS. It is a fresh log (first call, so `seq` is 0), run against the signed `property-trust-v1` ruleset.

---

**User:** Is our broker trust account short as of June 30? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `property` warehouse exposes `property/trust-vs-liability`, and calls it as of that date (no credential, and it carries checks):

```json
run_canonical { "name": "property/trust-vs-liability", "args": { "as_of": "2026-06-30" } }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [
    { "reconciled_bank_cents": 280000, "trust_liability_cents": 320000 }
  ],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "liability-recompute", "severity": "integrity", "status": "pass", "detail": { "total": 320000 } },
    { "id": "bank-covers-liability", "severity": "finding", "status": "flag",
      "rule": "reconciled_bank_cents >= trust_liability_cents",
      "message": "Trust shortfall: the reconciled bank balance is less than the itemized trust liability, so the broker is holding less than it owes to owners and tenants. Investigate before relying on either figure.",
      "detail": { "count": 1, "rows": [0] } }
  ],
  "lineage": {
    "resultHash": "7094f0dad268a50a6c53b471aa54df62ab230308c0b2def90202480348faf4bb"
  },
  "entry": {
    "seq": 0,
    "hash": "fc437999ecc9d565d593c696f5ab061be2ed5e8742bd2057ef1c072650522eaf",
    "rulesetHash": "5192f2b4bff504709e7dcef60d762fb098800f25fb3ad615dc67c3f4d71b2f76",
    "ruleset": { "name": "property", "version": "property-trust-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `liability-recompute` integrity check confirms the trust liability was re-derived from the ledger and ties, so the figures are safe to present), then reports the finding:

> **Sunset Key Realty & Property Management broker trust reconciliation, as of June 30, 2026.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional brokerage) and are synthetic.*
>
> **EXCEPTION, trust shortfall.** The reconciled bank balance of the trust account is **$2,800.00**, but the itemized trust liability, the total the brokerage owes across every owner and tenant ledger, is **$3,200.00**. The account is **$400.00 short**. The `bank-covers-liability` check flagged this. A broker trust account must always hold at least what it owes; investigate the missing funds, the latest reconciliation and any un-cleared items before relying on either figure. This is evidence for a licensed professional or a real estate commission auditor to confirm against the rules that apply; it is not a brokerage trust-account audit.
>
> **Audit trail.** Result hash `7094f0dad268a50a6c53b471aa54df62ab230308c0b2def90202480348faf4bb`; audit entry seq 0, hash `fc437999ecc9d565d593c696f5ab061be2ed5e8742bd2057ef1c072650522eaf`. Served by ruleset `property-trust-v1` (content hash `5192f2b4bff504709e7dcef60d762fb098800f25fb3ad615dc67c3f4d71b2f76`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note every dollar figure is the cents column divided by 100 exactly, no rounding, no independent arithmetic: the **$2,800.00** balance, the **$3,200.00** liability and the **$400.00** shortfall are all stated only because `reconciled_bank_cents` and `trust_liability_cents` are in the result (the shortfall is their difference, which the flag itself reports). The clean, passing shape of this control is the opposite: `reconciled_bank_cents >= trust_liability_cents` holds and the check reads `pass`. The negative-owner-balance, deposits-held and deposit-return controls are separate calls, each with its own checks and hash.
