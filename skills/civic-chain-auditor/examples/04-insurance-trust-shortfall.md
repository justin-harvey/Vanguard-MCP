# Example: a premium-trust shortfall (EXCEPTION)

The agent runs the insurance pack's solvency control and surfaces a fiduciary trust shortfall the automatic checks caught. Every figure comes from the tool result; the agent does no arithmetic of its own. Figures and hashes below are from a fresh demo log (first call, so `auditSeq` is 0), run against the signed `insurance-v1` ruleset.

---

**User:** Is Harborline's premium trust account solvent right now? Include the result hash.

**Agent** reads `civic-chain://warehouses`, sees the `insurance` warehouse exposes `insurance/trust-account-solvency`, and calls it first (no credential, and it carries checks):

```json
run_canonical { "name": "insurance/trust-account-solvency", "args": {} }
```

**Tool result** (trimmed to the fields the agent uses):

```json
{
  "rows": [{
    "total_collected_cents": 4500000,
    "total_remitted_cents": 3932500,
    "commission_drawn_cents": 500000,
    "net_trust_liability_cents": 67500,
    "bank_balance_cents": 40000
  }],
  "integrity": "pass",
  "findings": 1,
  "checks": [
    { "id": "collected-reconciles", "severity": "integrity", "status": "pass", "detail": { "total": 4500000 } },
    { "id": "trust-solvent", "severity": "finding", "status": "flag",
      "rule": "bank_balance_cents >= net_trust_liability_cents",
      "message": "Fiduciary trust shortfall: the trust bank balance is less than the net premium and commission obligations it is holding.",
      "detail": { "rows": [0], "count": 1 } }
  ],
  "lineage": {
    "resultHash": "0a2d416530151445b29481575a0135b7928cb454f251afce8faf652677e1d4dd"
  },
  "entry": {
    "seq": 0,
    "hash": "86e326af0268e50f7126ed5ce6c2e66d66d6014c0b36b39f32d04e0dd735c88c",
    "rulesetHash": "19d8c50680c45cf5ba3dc58456cd2188f9c87b007af7c5f3bd749e2feb019ba8",
    "ruleset": { "name": "insurance", "version": "insurance-v1", "status": "signed", "signedBy": "acb80e87885da931" }
  }
}
```

**Agent** checks `integrity` first (`pass`, and the `collected-reconciles` integrity check confirms the premium total against an independent query, so the figures are safe to present), then reports the finding:

> **Harborline Insurance Agency premium trust, solvency check.** *All figures are from the Civic-Chain Auditor demo ledger (a fictional agency) and are synthetic.*
>
> - Client premiums collected: **$45,000.00**
> - Carrier remittances paid: **$39,325.00**
> - Agency commission drawn: **$5,000.00**
> - Net trust liability (still owed out of trust): **$675.00**
> - Actual trust bank balance (latest snapshot): **$400.00**
>
> **EXCEPTION, fiduciary trust shortfall.** The trust bank balance of **$400.00** does not cover the **$675.00** the trust still owes, a shortfall of **$275.00**. The `trust-solvent` check flagged this. A shortfall in a fiduciary premium trust is a serious finding: it can mean client premiums were commingled with operating cash or that carrier payables are unfunded. This is evidence for your licensed professional to review against the agency's obligations; it is not a department-of-insurance audit opinion.
>
> **Audit trail.** Result hash `0a2d416530151445b29481575a0135b7928cb454f251afce8faf652677e1d4dd`; audit entry seq 0, hash `86e326af0268e50f7126ed5ce6c2e66d66d6014c0b36b39f32d04e0dd735c88c`. Served by ruleset `insurance-v1` (content hash `19d8c50680c45cf5ba3dc58456cd2188f9c87b007af7c5f3bd749e2feb019ba8`), **signed** by Civic-Chain key `acb80e87885da931`. The entry is hash-chained; re-running the same query against the same snapshot reproduces the result hash.

Note the dollar figures are the cents columns divided by 100 exactly, no rounding, no independent arithmetic. The `$275.00` shortfall is the one figure the agent states that is not a column; it is stated only because both operands ($400.00 and $675.00) are in the result, and even so a stricter reading would ask the control to return it. The empty-result controls (`commission-variance-audit`, `eo-unbound-exposure`) are the opposite shape: there, no rows means the control passed.
