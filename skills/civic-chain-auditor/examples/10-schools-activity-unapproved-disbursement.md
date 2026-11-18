# Example: a student activity payment made without the required approval (EXCEPTION)

The agent runs the School Districts pack's activity-unapproved-disbursements control and surfaces a student activity disbursement that is missing one of the two required sign-offs. Every figure comes from the tool result; the agent does no arithmetic of its own, and it never decides what counts as approved, which the engine reads from the ledger's `advisor_approved` and `principal_approved` flags. Figures and hashes below are from a demo log in which a Drama Club disbursement was deliberately stripped of its principal approval, to show the EXCEPTION path; the shipped demo seed is clean and reads PASS. It is a fresh log (first call, so `auditSeq` is 0), run against the signed `schools-v1` ruleset.

---

**User:** Did we pay anything out of a student activity account without the required approvals? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `schools` warehouse exposes `schools/activity-unapproved-disbursements`, and calls it (no credential, and it carries checks):

```json
run_canonical { "name": "schools/activity-unapproved-disbursements", "args": {} }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [
    { "disbursement_id": "DIS-1", "account_id": "ACT-DRAMA", "fiscal_year": 2026,
      "amount_cents": 120000, "disbursement_date": "2026-03-20",
      "advisor_approved": 1, "principal_approved": 0, "reason": "MISSING_PRINCIPAL" }
  ],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "one-row-per-disbursement", "severity": "integrity", "status": "pass" },
    { "id": "disbursements-approved", "severity": "finding", "status": "flag",
      "message": "A student activity disbursement is missing the advisor or the principal approval. Activity-fund payments require both sign-offs; confirm the approvals before relying on the payment, because a disbursement without them has no documented authorization.",
      "detail": { "count": 1, "rows": ["DIS-1"] } }
  ],
  "lineage": {
    "resultHash": "5e63fde79c2b0a9ba39707a430c4b9ef1246e7cc9025e80e41ec5ec546c27326"
  },
  "entry": {
    "seq": 0,
    "hash": "1053657f34b4cfe039d40961e3c351921be8f3e0771192ae0a613ebf47c04684",
    "rulesetHash": "0c692a72bf7e707ca7886d14bc78da580205da2b45da030aa0ca463b9c0bf2d2",
    "ruleset": { "name": "schools", "version": "schools-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `one-row-per-disbursement` integrity check confirms the result was not multiplied by a JOIN, so the figures are safe to present), then reports the finding:

> **Kennebec Valley Regional School Unit student activity disbursements.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional Maine school district) and are synthetic.*
>
> **EXCEPTION, a payment missing a required approval.** One disbursement, **DIS-1** for **$1,200.00**, was paid from the **Drama Club** account (`ACT-DRAMA`) on **2026-03-20** with the advisor's sign-off but **no principal approval** on record (`reason: MISSING_PRINCIPAL`). The `disbursements-approved` check flagged it. Activity-fund payments require both the advisor and the principal sign-off; confirm the approval before relying on the payment, because a disbursement without it has no documented authorization. This is evidence for a licensed professional or a school-district auditor to confirm against the district's activity-fund policy; it is not a financial-statement or Single Audit.
>
> **Audit trail.** Result hash `5e63fde79c2b0a9ba39707a430c4b9ef1246e7cc9025e80e41ec5ec546c27326`; audit entry seq 0, hash `1053657f34b4cfe039d40961e3c351921be8f3e0771192ae0a613ebf47c04684`. Served by ruleset `schools-v1` (content hash `0c692a72bf7e707ca7886d14bc78da580205da2b45da030aa0ca463b9c0bf2d2`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note every dollar figure is the cents column divided by 100 exactly, no rounding, no independent arithmetic: the **$1,200.00** is stated only because `amount_cents` is in the result. The agent never decides what counts as approved; the two sign-offs live in the ledger's `activity_disbursements` table (`advisor_approved`, `principal_approved`), so a correction is a data update, not a new signed ruleset. The clean, passing shape of this control is the opposite: every disbursement carries both approvals, the query returns no rows, and the `empty` check reads `pass`. The activity-negative-balances, activity-deposits-late, federal-outside-period and budget-variance controls are separate calls, each with its own checks and hash, and student records are never read: the `student_records` table is not allow-listed, so any question that would reach it is refused under FERPA.
