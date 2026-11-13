# Example: a grant-status finding

The agent surfaces an audit finding the automatic checks caught: grant cash drawn down ahead of spending. All figures come from the tool result; the agent does no arithmetic of its own. Figures and hashes below are from a fresh demo log (first call, so `auditSeq` is 0).

---

**User:** How much of the paving grant (G-402) has been spent so far? Flag anything unusual, and include the result hash.

**Agent** reads `vanguard://warehouses`, sees the `municipal` warehouse exposes `municipal/grant-status`, and calls it first (no credential, and it carries checks):

```json
run_canonical { "name": "municipal/grant-status", "args": { "grant_id": "G-402" } }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [{
    "grant_id": "G-402",
    "grant_name": "Municipal Paving Program 2026",
    "grantor": "State Department of Transportation",
    "status": "active",
    "award_cents": 125000000,
    "paid_cents": 93165000,
    "pending_cents": 9880000,
    "drawn_cents": 100000000,
    "remaining_cents": 31835000,
    "drawn_minus_paid_cents": 6835000,
    "pct_award_spent": 74.5
  }],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "one-row-per-grant", "severity": "integrity", "status": "pass" },
    { "id": "paid-total-reconciles", "severity": "integrity", "status": "pass", "detail": { "total": 93165000 } },
    { "id": "spending-within-award", "severity": "finding", "status": "pass" },
    { "id": "cash-not-ahead-of-spending", "severity": "finding", "status": "flag",
      "message": "More grant cash has been drawn down than has been spent; the excess is grantor money held in advance.",
      "detail": { "rows": ["G-402"], "count": 1 } }
  ],
  "provenance": {
    "resultHash": "48c6ee7a162877906c2c3cb7a9775fb95c9b0934fa8cee844d8ffa7637bc608e",
    "auditSeq": 0,
    "auditHash": "fe4feeed7731eb05da39a418d63e54daa3d47f1b7d58edb8c3db26850ae862a3"
  }
}
```

**Agent** checks `integrity` first (`pass`, so the figures are safe to present), then reports the one finding:

> **Municipal Paving Program 2026 (G-402), State Department of Transportation — active.** *All figures are from the Vanguard demo ledger (a fictional town) and are synthetic.*
>
> - Award: **$1,250,000.00**
> - Paid (spent): **$931,650.00** — **74.5%** of the award
> - Pending (approved, unpaid): **$98,800.00**
> - Cash drawn down from the grantor: **$1,000,000.00**
> - Remaining balance: **$318,350.00**
>
> **Finding — cash drawn ahead of spending.** $1,000,000.00 has been drawn from the grantor but only $931,650.00 spent, so **$68,350.00** is grantor money held in advance. The `cash-not-ahead-of-spending` check flagged this. (The integrity checks — one row per grant, and the paid total reconciling to an independent query — passed, so the figures themselves are trustworthy.)
>
> **Audit trail.** Result hash `48c6ee7a162877906c2c3cb7a9775fb95c9b0934fa8cee844d8ffa7637bc608e`; audit entry seq 0, hash `fe4feeed7731eb05da39a418d63e54daa3d47f1b7d58edb8c3db26850ae862a3`. The entry is hash-chained but unsigned. Re-running the same query against the same snapshot reproduces the result hash.

Note the dollar figures are the cents columns divided by 100 exactly — no rounding, no independent arithmetic.
