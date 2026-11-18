# Example: an expense charged outside a donor restriction (EXCEPTION)

The agent runs the Nonprofit Restricted Funds pack's restricted-spending control and surfaces an expense charged to a donor-restricted fund for a program other than the one the restriction allows. Every figure comes from the tool result; the agent does no arithmetic of its own, and it never decides what a fund's restriction is, which the engine reads from the ledger's `funds` table. Figures and hashes below are from a demo log in which a scholarship-fund expense was deliberately recoded to a travel program, to show the EXCEPTION path; the shipped demo seed is clean and reads PASS. It is a fresh log (first call, so `auditSeq` is 0), run against the signed `nonprofit-v1` ruleset.

---

**User:** Did we spend any of our restricted funds outside what the donors restricted them to, in FY2026? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `nonprofit` warehouse exposes `nonprofit/restricted-spending`, and calls it for the fiscal year (no credential, and it carries checks):

```json
run_canonical { "name": "nonprofit/restricted-spending", "args": { "fiscal_year": 2026 } }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [
    { "expense_id": "EXP-1", "fiscal_year": 2026, "fund_id": "FND-SCHOL",
      "program_code": "TRAVEL", "purpose_code": "SCHOLARSHIP", "expense_date": "2026-03-15",
      "amount_cents": 5000000, "reason": "OUT_OF_PURPOSE" }
  ],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "one-row-per-expense", "severity": "integrity", "status": "pass" },
    { "id": "no-restricted-misspending", "severity": "finding", "status": "flag",
      "message": "An expense charged to a donor-restricted fund is outside its purpose or time window. Confirm the fund's restriction and the coding before relying on the figure; restricted money spent outside the restriction may need to be reclassed or refunded.",
      "detail": { "count": 1, "rows": ["EXP-1"] } }
  ],
  "lineage": {
    "resultHash": "46c1851edc11cb10b9f3e6bba9748f2e223f9f9ab22c5354972196b4f1a42874"
  },
  "entry": {
    "seq": 0,
    "hash": "3eac12c22254f1fa6522cf3da0aca5071607eb0c27f34dcb35e8188a4e8a3293",
    "rulesetHash": "384244469d16eb52f53ee151a7b17604eaf6496fc5e35a7ffba3b1ec1394f5b5",
    "ruleset": { "name": "nonprofit", "version": "nonprofit-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `one-row-per-expense` integrity check confirms the result was not multiplied by a JOIN, so the figures are safe to present), then reports the finding:

> **Merrymeeting Bay Community Services restricted-fund spending, FY2026.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional nonprofit) and are synthetic.*
>
> **EXCEPTION, spending outside a donor restriction.** One expense, **EXP-1** for **$50,000.00**, was charged to the **Scholarship Fund** (`FND-SCHOL`), which donors restricted to the **SCHOLARSHIP** purpose, but the expense was coded to the **TRAVEL** program (`reason: OUT_OF_PURPOSE`). The `no-restricted-misspending` check flagged it. Confirm the fund's restriction and the coding; restricted money spent outside its restriction may need to be reclassed to an unrestricted fund or refunded to the restriction. This is evidence for a licensed professional or an auditor under Uniform Guidance to confirm against the gift instrument; it is not a financial-statement or Single Audit.
>
> **Audit trail.** Result hash `46c1851edc11cb10b9f3e6bba9748f2e223f9f9ab22c5354972196b4f1a42874`; audit entry seq 0, hash `3eac12c22254f1fa6522cf3da0aca5071607eb0c27f34dcb35e8188a4e8a3293`. Served by ruleset `nonprofit-v1` (content hash `384244469d16eb52f53ee151a7b17604eaf6496fc5e35a7ffba3b1ec1394f5b5`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note every dollar figure is the cents column divided by 100 exactly, no rounding, no independent arithmetic: the **$50,000.00** is stated only because `amount_cents` is in the result. The agent never decides what a fund's restriction is; it lives in the ledger's `funds` table (`purpose_code`, `window_start`, `window_end`), so a restriction change is a data update, not a new signed ruleset. The clean, passing shape of this control is the opposite: no restricted-fund expense is coded outside its purpose or dated outside its window, the query returns no rows, and the `empty` check reads `pass`. The releases-versus-spending, functional-expense-tie, restricted-cash-coverage and single-audit-threshold controls are separate calls, each with its own checks and hash.
