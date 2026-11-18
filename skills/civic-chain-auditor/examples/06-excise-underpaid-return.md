# Example: an underpaid excise return (EXCEPTION)

The agent runs the Excise Tax pack's liability control and surfaces a beer excise return that paid less than the taxable removals times the rate in force. Every figure comes from the tool result; the agent does no arithmetic of its own, and it never supplies the rate, which the engine reads from the ledger's `tax_rates` table by effective date. Figures and hashes below are from a demo log in which the January return was deliberately underpaid, to show the EXCEPTION path; the shipped demo seed is clean and reads PASS. It is a fresh log (first call, so `auditSeq` is 0), run against the signed `excise-v1` ruleset.

---

**User:** Did our January beer excise return pay enough against the barrels we removed? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `excise` warehouse exposes `excise/liability-vs-remitted`, and calls it for the January period (no credential, and it carries checks):

```json
run_canonical { "name": "excise/liability-vs-remitted", "args": { "period": "2026-01" } }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [
    { "period": "2026-01", "taxable_barrels": 400, "rate_cents_per_barrel": 350,
      "expected_tax_cents": 140000, "tax_paid_cents": 100000 }
  ],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "removals-recompute", "severity": "integrity", "status": "pass", "detail": { "total": 400 } },
    { "id": "tax-paid-covers-liability", "severity": "finding", "status": "flag",
      "rule": "tax_paid_cents >= expected_tax_cents",
      "message": "Underpaid excise return: the tax paid for this period is less than the taxable removals times the rate in force. Confirm the removals, the rate and the return before relying on the figure.",
      "detail": { "count": 1, "rows": ["2026-01"] } }
  ],
  "lineage": {
    "resultHash": "6c7940f7984016675558b08082c9fe7b73d48a71c4d4c5089930e4aaff8cc744"
  },
  "entry": {
    "seq": 0,
    "hash": "83158f862f92db6d0b3369a7cf401eff57bfa1ced39ec5396e4aaf79d853d640",
    "rulesetHash": "9baf7fa0584a0ef2500059f2b9dc9d37c74894d8c01538dd74da35c661e5ee1d",
    "ruleset": { "name": "excise", "version": "excise-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `removals-recompute` integrity check confirms the barrels total was not multiplied by a JOIN, so the figures are safe to present), then reports the finding:

> **Penobscot Bay Brewing Co. beer excise, January 2026 liability check.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional brewery) and are synthetic.*
>
> **EXCEPTION, underpaid return.** For the **2026-01** period the brewery removed **400 barrels** of beer from bond. At the per-barrel rate in force for that period, **$3.50** (350 cents, read from the rate schedule, not supplied by me), the excise due is **$1,400.00**. The return paid **$1,000.00**, so it is **$400.00 short**. The `tax-paid-covers-liability` check flagged this. Confirm the removals, the rate on file and the return; an underpaid excise return typically must be corrected with an amended return and any interest or penalty. This is evidence for a licensed professional or revenue auditor to confirm against the law that applies; it is not a TTB or state excise audit.
>
> **Audit trail.** Result hash `6c7940f7984016675558b08082c9fe7b73d48a71c4d4c5089930e4aaff8cc744`; audit entry seq 0, hash `83158f862f92db6d0b3369a7cf401eff57bfa1ced39ec5396e4aaf79d853d640`. Served by ruleset `excise-v1` (content hash `9baf7fa0584a0ef2500059f2b9dc9d37c74894d8c01538dd74da35c661e5ee1d`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note every dollar figure is the cents column divided by 100 exactly, no rounding, no independent arithmetic: the **$3.50** rate, the **$1,400.00** due and the **$400.00** shortfall are all stated only because `rate_cents_per_barrel`, `expected_tax_cents` and `tax_paid_cents` are in the result. The rate is never something the agent knows or looks up; it lives in the ledger's `tax_rates` table so a rate change is a data update, not a new signed ruleset. The clean, passing shape of this control is the opposite: `tax_paid_cents >= expected_tax_cents` holds for every period and the check reads `pass`. The rollforward, report-versus-return, missing-or-late-filing and loss-variance controls are separate calls, each with its own checks and hash.
