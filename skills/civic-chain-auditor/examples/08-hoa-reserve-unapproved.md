# Example: an unapproved HOA reserve withdrawal (FLAG)

The agent runs the Property Management & HOA pack's reserve-transfer control and surfaces money moved out of the association's reserve account with no board approval on record. California Civil Code s 5502 requires prior written board approval for a transfer out of reserves. Every figure comes from the tool result. Figures and hashes below are from a demo log in which the approving minutes reference was deliberately removed, to show the FLAG path; the shipped demo seed is clean and reads PASS. It is a fresh log (first call, so `seq` is 0), run against the signed `hoa-v1` ruleset.

---

**User:** Were any of our HOA reserves spent without board approval?

**Agent** reads `civic-chain://warehouses`, sees the `hoa` warehouse exposes `hoa/reserve-transfers-unapproved`, and calls it (no arguments, no credential, and it carries checks):

```json
run_canonical { "name": "hoa/reserve-transfers-unapproved", "args": {} }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [
    { "transfer_id": "RT-1", "transfer_date": "2026-02-15", "from_account": "RESERVE", "to_account": "OPERATING", "amount_cents": 200000 }
  ],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "one-row-per-transfer", "severity": "integrity", "status": "pass" },
    { "id": "no-unapproved-reserve-transfers", "severity": "finding", "status": "flag",
      "message": "Reserve money was moved with no board approval on record. California Civil Code s 5502 requires prior written board approval for a transfer out of reserves; record the approving board action or reverse the transfer.",
      "detail": { "count": 1, "rows": ["RT-1"] } }
  ],
  "lineage": {
    "resultHash": "cb874981d7101dbc28fa253b609a2cabdff602d325257416d0b7e449bd314bd1"
  },
  "entry": {
    "seq": 0,
    "hash": "d9ad416736ac613007685b5714b8ac5ad9ce3c31cf9975f339b09417f832d402",
    "rulesetHash": "aa8e91de911eb05cebda35e7b880d041298dfdc5a7650cffb7105fa1777caca7",
    "ruleset": { "name": "hoa", "version": "hoa-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`), then reports the flag:

> **Palm Grove Community Association reserve-transfer review.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional HOA) and are synthetic.*
>
> **FLAG, reserve withdrawal with no approval on record.** Transfer **RT-1** moved **$2,000.00** out of the reserve account into operating on **2026-02-15**, and no board approval is recorded against it. California Civil Code s 5502 requires prior written board approval for a transfer out of reserves. Record the approving board action (minutes, resolution) or reverse the transfer. A transfer *into* reserve needs no approval and is never reported here. This is evidence for the board, manager or association auditor to confirm against the governing documents; it is not an HOA audit.
>
> **Audit trail.** Result hash `cb874981d7101dbc28fa253b609a2cabdff602d325257416d0b7e449bd314bd1`; audit entry seq 0, hash `d9ad416736ac613007685b5714b8ac5ad9ce3c31cf9975f339b09417f832d402`. Served by ruleset `hoa-v1` (content hash `aa8e91de911eb05cebda35e7b880d041298dfdc5a7650cffb7105fa1777caca7`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note the **$2,000.00** is `amount_cents` divided by 100 exactly, no rounding. This is an `empty`-style control: an empty result is the clean, passing case (every reserve withdrawal cites its approval), and only a returned row is a FLAG. The budget-variance and delinquent-assessment controls are separate calls, each with its own checks and hash.
