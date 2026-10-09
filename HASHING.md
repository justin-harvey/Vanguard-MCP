# How Fin-Telligence uses hashes

Fin-Telligence uses hashing for two separate jobs:

1. **Reproducibility:** proving an answer comes out the same when it's re-run against the same data.
2. **Tamper evidence:** proving that nothing in the record of what was asked and answered has been edited afterwards.

Each job has its own hash. Keeping them separate is the key to understanding the system.

> **Field names** below match the live code: the lineage record in `src/lineage.js` and the chaining fields added in `src/audit.js`. The JSON in section 2 is a representative subset of a real entry, not the full field list.

---

## 1. The result hash: does the answer reproduce?

The result hash is computed from **the rows the database returned** for a query.

```
SQL + as-of date + snapshot data  →  rows  →  result hash
```

- Re-running the same SQL with the same as-of date against the same snapshot produces the **same hash**.
- A different hash means something changed: the data, the query, or the as-of date.
- Because restatements are stored as new rows (bitemporal storage), an as-of query keeps reproducing its original hash even after a vendor restates a figure.

### Why the question is not part of the result hash

The same question can produce different SQL on different days, because model output varies. Reproducibility is therefore keyed on **SQL + as-of date + data**, not on the wording of the question. The question belongs in the audit record (below).

### Making the hash stable

For the same answer to always give the same hash, the rows must be put into a canonical form before hashing:

- **Consistent row order.** Without an `ORDER BY`, a database may return identical rows in a different order, which would change the hash.
- **Consistent value formatting.** Numbers, NULLs and column order must serialize the same way every time.

### What it's used for

- **Audits:** an auditor re-runs the recorded SQL at the recorded as-of date and compares hashes, without re-checking every number by hand.
- **Evals:** a model's answer is correct if its result hash matches the hash of a hand-written canonical query.
- **Caching:** identical SQL and as-of date can return a cached result safely.

---

## 2. The audit entry hash: was anything edited?

Every question is written to an append-only log (JSON Lines). Each entry records the whole event:

```json
{
  "seq":               2,
  "prevHash":          "hash of the previous entry",
  "question":          "What was IBM's gross profit in FY2023?",
  "actor":             "who asked",
  "at":                "2026-10-09T14:00:00.000Z",
  "sql":               "the SELECT the model wrote",
  "tables":            ["income_statement"],
  "columns":           ["gross_profit"],
  "rowCount":          1,
  "resultHash":        "hash from section 1",
  "narrationGrounded": true,
  "llmScope":          "sql_generation_only",
  "complianceTags":    ["SOX", "GDPR: no PII"],
  "hash":              "this entry's own hash, over every field above"
}
```

The **entry hash** (`hash`) is computed over the entire entry, including `prevHash` and `resultHash`. The `hash`, `signature` and `signingKeyId` fields are excluded from the hash itself (a signature is computed *over* the hash, so it can't also be *inside* it).

So the question **is** protected: it's inside the entry, and changing it afterwards changes the entry hash.

### What the entry does not store

The log keeps the `question`, the `sql`, the `resultHash`, and whether narration was grounded (`narrationGrounded`), **not the prose answer the user read**. The same SQL and data can be narrated in slightly different words on different runs, so the prose is reproducible from the SQL and the snapshot rather than retained. What matters for audit is protected: the exact query, the fingerprint of its rows, and the verdict that every figure in the prose was grounded in those rows. If a question itself may carry confidential information, store it encrypted or store only its hash (see [section 6](#6-honest-limits)).

---

## 3. The hash chain

Each entry includes the hash of the entry before it (`prevHash`). The first entry points at a fixed genesis value (`GENESIS`, 64 zeros):

```
Entry 0            Entry 1            Entry 2
prev: 000…         prev: hash(E0)     prev: hash(E1)
data: …     ──►    data: …     ──►    data: …
hash: H0           hash: H1           hash: H2
```

If anyone edits or deletes a past entry:

- that entry's hash changes,
- the next entry's `prevHash` no longer matches,
- and every entry after it fails verification.

`verify()` walks the chain and reports **the first index where it breaks**.

**What it proves:** the log hasn't been edited since each entry was written.

**What it doesn't prevent:** the chain makes tampering *visible*; it can't stop someone from trying.

---

## 4. Strengthening the chain

A plain hash chain has one weakness: someone with full write access to the log could rewrite **every** entry from the altered one onward, recomputing all the hashes, and the result would verify cleanly. Two additional layers close that gap.

| Level | Protects against | Remaining gap |
| --- | --- | --- |
| **Hash chain** | Accidental corruption; editing a single record | Rewriting the whole chain from an edit point onward |
| **+ Signing (Ed25519, optional)** | Rewriting without the private key | Whoever holds the key can re-sign a rewritten history |
| **+ External anchor (pluggable hook)** | Even an admin with the key rewriting history | None of practical concern, if the anchor is outside your control |

### Signing

Each entry can be signed with an Ed25519 private key. Forging a rewritten chain then also requires that key.

### External anchoring

Periodically publish the latest entry hash (a checkpoint) somewhere **outside your control**. A rewritten history no longer matches the published checkpoint.

The anchor does **not** have to be a blockchain:

| Anchor | When it fits |
| --- | --- |
| **WORM storage** (write once, read many, e.g. immutable cloud storage with a retention lock) | Regulated firms; compliance teams already audit this model |
| **Trusted timestamping** (RFC 3161) | Proving a hash existed at a specific time |
| **Sending checkpoints to the auditor or customer** | Simple, and the other party holds their own copy |
| **Public blockchain** | Only when no single third party can be trusted |

For a regulated client such as LSEG, signed entries plus periodic anchoring to WORM storage or a timestamp authority is usually the better fit. A blockchain anchor remains available through the hook when a trust-no-one guarantee is required.

---

## 5. Verification, step by step

**To verify an answer reproduces:**

1. Take the `sql` and as-of date from the audit entry.
2. Re-run the query against the snapshot.
3. Canonicalize the rows and hash them.
4. Compare with the recorded `result_hash`. A match means the answer reproduces.

**To verify the log hasn't been edited:**

1. Run `verify()`; it recomputes each entry hash, checks every `prevHash` link, and confirms each entry's `seq` matches its position (so a removed or reordered entry is caught too). It reports the first index where the chain breaks.
2. If signing is on, check each entry's signature against the public key.
3. If anchoring is on, compare the chain's hash at each checkpoint with the published anchor.

---

## 6. Honest limits

- **"Immutable" is not the right word.** The log is **tamper-evident**: changes are detectable, not impossible.
- **Signing is optional** today, and **external anchoring is a hook that isn't wired** to a destination yet.
- **Sensitive questions:** if questions may contain confidential information, store them encrypted or store only their hash. A hash alone proves the question wasn't changed, but nobody can read it during an audit.
- **Compliance:** these hashes produce *evidence*. SOC 2, SOX and similar are properties of organizations and processes, not of software.

---

## Summary

> There are two hashes. The **result hash** proves the answer reproduces from the data. The **entry hash** covers the whole event (the question, the SQL, the result hash, the grounding verdict and who asked), and chaining it proves none of that was edited afterwards. Signing and an external anchor make even a full rewrite of history detectable.
