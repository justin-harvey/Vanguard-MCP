# Example: an overdrawn client trust ledger (EXCEPTION)

The agent runs the IOLTA pack's negative-balance control and surfaces an overdrawn client ledger the automatic checks caught: the single most serious client-trust error, because one client's money is covering another's disbursement. Every figure comes from the tool result; the agent does no arithmetic of its own. Figures and hashes below are from a fresh demo log (first call, so `auditSeq` is 0), run against the signed `iolta-v1` ruleset.

---

**User:** Is any client's trust ledger at Northfield overdrawn? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `iolta` warehouse exposes `iolta/negative-client-balances`, and calls it first (no credential, and it carries checks):

```json
run_canonical { "name": "iolta/negative-client-balances", "args": {} }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [{ "client_id": "C-100", "balance_cents": -200000 }],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "one-row-per-client", "severity": "integrity", "status": "pass" },
    { "id": "no-negative-balances", "severity": "finding", "status": "flag",
      "message": "An overdrawn client ledger: this client's trust balance is negative, so another client's money is funding its disbursements. Correct the posting or restore the funds immediately.",
      "detail": { "count": 1, "rows": ["C-100"] } }
  ],
  "lineage": {
    "resultHash": "51881e2ea8806e9c16b0f47861a12dedecbf426d0e093555bc5b096b95a35286"
  },
  "entry": {
    "seq": 0,
    "hash": "26838d55a9997d163b54222eb7849b752f25548e02df8b7117f0409f48d7aaa7",
    "rulesetHash": "5343bceb108576097aab7714ee0f36d37d0147e84f82701260499ae7112a2cc8",
    "ruleset": { "name": "iolta", "version": "iolta-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `one-row-per-client` integrity check confirms the ledger was not multiplied by a JOIN, so the figure is safe to present), then reports the finding:

> **Northfield Law Group client trust (IOLTA), overdrawn-ledger check.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional firm) and are synthetic. Clients are identified by ID only.*
>
> **EXCEPTION, overdrawn client ledger.** Client **C-100** has a trust balance of **−$2,000.00**. A negative client ledger means more money has been disbursed or transferred out for that client than was ever deposited for them, so another client's funds are covering the shortfall. The `no-negative-balances` check flagged this. This is the most serious client-trust error there is and typically must be corrected the day it is discovered: find the posting error or restore the funds, and reconcile the account. This is evidence for your licensed professional to review against the firm's obligations and your state's trust-account rules; it is not a bar trust-account audit.
>
> **Audit trail.** Result hash `51881e2ea8806e9c16b0f47861a12dedecbf426d0e093555bc5b096b95a35286`; audit entry seq 0, hash `26838d55a9997d163b54222eb7849b752f25548e02df8b7117f0409f48d7aaa7`. Served by ruleset `iolta-v1` (content hash `5343bceb108576097aab7714ee0f36d37d0147e84f82701260499ae7112a2cc8`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same ledger reproduces the result hash.

Note the dollar figure is the cents column divided by 100 exactly, no rounding, no independent arithmetic. The `−$2,000.00` is stated only because `balance_cents` is in the result. The clean, passing shape of this control is the opposite: an empty result (no rows) means no client ledger is overdrawn, not "no data". The firm's three-way reconciliation (`iolta/three-way-reconciliation`), unsupported-fee and dormancy controls are separate calls, each with its own checks and hash.
