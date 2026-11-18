# Example: a job headed for a loss (EXCEPTION)

The agent runs the Construction Contracts pack's loss-jobs control and surfaces a job whose estimated cost at completion has risen above its contract value, a loss job. Every figure comes from the tool result; the agent does no arithmetic of its own, and it never decides what counts as a loss, which the engine reads from the ledger's `contract_value_cents` and `estimated_cost_cents`. Figures and hashes below are from a demo log in which the Riverside School Addition's estimated cost was raised above its contract value, to show the EXCEPTION path; the shipped demo seed is clean and reads PASS. It is a fresh log (first call, so `auditSeq` is 0), run against the signed `construction-v1` ruleset.

---

**User:** Is any job headed for a loss? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `construction` warehouse exposes `construction/loss-jobs`, and calls it (no credential, and it carries checks):

```json
run_canonical { "name": "construction/loss-jobs", "args": {} }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [
    { "job_id": "J-100", "job_name": "Riverside School Addition", "status": "OPEN",
      "contract_value_cents": 200000000, "estimated_cost_cents": 250000000,
      "estimated_loss_cents": 50000000 }
  ],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "one-row-per-loss-job", "severity": "integrity", "status": "pass" },
    { "id": "no-loss-jobs", "severity": "finding", "status": "flag",
      "message": "A job's estimated cost at completion exceeds its contract value, so the job is headed for a loss. Under ASC 606 the full estimated loss is recognized as soon as it is known; confirm the cost estimate and the contract value, because the loss should already be on the books.",
      "detail": { "count": 1, "rows": ["J-100"] } }
  ],
  "lineage": {
    "resultHash": "a2be24072263ec55036c7914b13dca04b29b16fffe5579ec8e18bb17dae74d5a"
  },
  "entry": {
    "seq": 0,
    "hash": "6f79f16bb99923b159bba759d6d33cade97e1dcc917188809d1c7c0fab547db5",
    "rulesetHash": "4ab023677a7b9f74def588c74599a71df67c0717faaaa0cd44878cdc7e2335c5",
    "ruleset": { "name": "construction", "version": "construction-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `one-row-per-loss-job` integrity check confirms the result was not multiplied by a JOIN, so the figures are safe to present), then reports the finding:

> **Granite State Builders work-in-progress.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional contractor) and are synthetic.*
>
> **EXCEPTION, a job headed for a loss.** One job, **J-100 Riverside School Addition**, now carries an estimated cost at completion of **$2,500,000.00** against a contract value of **$2,000,000.00**, an estimated loss of **$500,000.00** (`estimated_loss_cents: 50000000`). The `no-loss-jobs` check flagged it. Under ASC 606 the full estimated loss on a contract is recognized as soon as it is known, not spread over the job, so this loss should already be on the books; confirm the cost estimate and the contract value before relying on the figure. This is evidence for a licensed professional, a construction-industry CPA or a surety underwriter to confirm against the contract and the estimate; it is not a financial-statement audit.
>
> **Audit trail.** Result hash `a2be24072263ec55036c7914b13dca04b29b16fffe5579ec8e18bb17dae74d5a`; audit entry seq 0, hash `6f79f16bb99923b159bba759d6d33cade97e1dcc917188809d1c7c0fab547db5`. Served by ruleset `construction-v1` (content hash `4ab023677a7b9f74def588c74599a71df67c0717faaaa0cd44878cdc7e2335c5`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note every dollar figure is the cents column divided by 100 exactly, no rounding, no independent arithmetic: the **$500,000.00** loss is stated only because `estimated_loss_cents` is in the result. The agent never decides what counts as a loss; the contract value and the estimated cost at completion live in the ledger's `jobs` table, so a correction is a data update, not a new signed ruleset. The clean, passing shape of this control is the opposite: every job's estimated cost is within its contract value, the query returns no rows, and the `empty` check reads `pass`. The wip-schedule, billings-tie-out, margin-fade, retainage-reconciles and payments-without-lien-waiver controls are separate calls, each with its own checks and hash, and employee pay is never read: the `payroll_pii` table is not allow-listed, so any question that would reach it is refused.
