# Fin-Telligence compared with existing tools

Fin-Telligence combines three ideas that each exist elsewhere: guarded text-to-SQL, verification of AI-generated financial figures, and tamper-evident audit logs. What's distinctive is how tightly they're bound together, not any single component.

> Competitor descriptions are based on public documentation and research as of October 2026, at a high level. Verify specifics before citing them externally.

---

## The landscape at a glance

| Category | Examples | What they share with Fin-Telligence | Where Fin-Telligence differs |
| --- | --- | --- | --- |
| **Text-to-SQL analytics** | Snowflake Cortex Analyst, Databricks AI/BI Genie, Microsoft Fabric Copilot | Natural-language questions answered by generated SQL over a governed schema; Cortex Analyst uses a semantic model and a repository of verified queries | These focus on producing correct SQL. Fin-Telligence also verifies every figure in the *prose answer* against the returned rows, and refuses if one doesn't match |
| **Financial claim verification** | Research such as VeriFin and FinGround; verification-layer startups | Checking that numbers in AI-generated financial text are supported by data | These typically verify claims *after* generation against sources. Fin-Telligence prevents the model from ever seeing data, so it has no numbers to invent, then verifies as a second line |
| **Tamper-evident ledgers** | SQL Server / Azure SQL Database ledger | Hash-chained records with externally stored digests to detect tampering | Ledgers protect *database changes*. Fin-Telligence chains each *question-and-answer event*: the question, SQL, lineage, result hash and answer |
| **AI guardrail platforms** | Content-safety and prompt-injection filters | Constraining what an AI system can do and output | General filters screen text. Fin-Telligence's controls are domain-specific and enforced in code: AST guard, read-only connection, allow-lists |

---

## Similarities

- **The model doesn't decide the numbers.** Like Cortex Analyst and other governed text-to-SQL tools, the database computes results and the model produces queries.
- **Governed schemas.** Allow-listed tables and columns resemble semantic models and governed data catalogs.
- **Verification of financial claims** is an active research area; Fin-Telligence uses the same core idea of matching figures to source data.
- **Hash chaining and external digests** follow the same construction as database ledgers.

## Differences

1. **The model never sees a row.** Many tools pass query results back to the model to write the answer. Fin-Telligence limits the model to writing SQL, and every stated figure must be computed in SQL.
2. **Verify-or-refuse on the prose.** Each number in the final answer is checked against the returned rows. Unmatched figures cause a refusal, not a warning.
3. **One attestation per answer.** Question, SQL, lineage, a reproducible result hash and the answer are recorded together in one chained, optionally signed entry.
4. **Bitemporal as-of reads.** Restatements are new rows, so an answer can be reproduced exactly as it stood on a past date, with the same hash.
5. **Vendor-data awareness.** Built around LSEG concepts: `TR.*` field codes, PermID vs RIC identity, standardized vs as-reported basis, and entitlement errors (a 403 is not missing data).
6. **Claim discipline.** The system separates checks that prove pipeline integrity from checks that test the data, and reports missing values as N/A rather than zero.

## Where existing tools are ahead

Honest gaps, since Fin-Telligence is a prototype:

- **Scale and operations.** Commercial platforms run on production warehouses with mature security, access control and support. Fin-Telligence runs on SQLite with synthetic values.
- **Breadth.** They handle general business questions across many schemas; Fin-Telligence covers four demo warehouses.
- **Usability.** Commercial tools answer more questions fluently. Fin-Telligence deliberately refuses more often.
- **Live data.** The LSEG bridge is code-complete but hasn't run against an entitled session.

---

## Summary

> None of the components are new: ledgers, guarded text-to-SQL and claim verification all exist. Fin-Telligence's contribution is combining them so a regulated user can't receive an unverified figure, and every answer leaves a reproducible, tamper-evident record.

## Sources

- [SQL Server 2022 ledger (Microsoft Learn)](https://learn.microsoft.com/en-us/training/modules/sql-server-2022-security-scalability-availability/2-ledger)
- [Using ledger in Azure SQL Database (Microsoft)](https://devblogs.microsoft.com/azure-sql/?p=1867)
- [Snowflake Cortex Analyst: behind the scenes](https://snowflake.com/engineering-blog/snowflake-cortex-analyst-behind-the-scenes)
- [Cortex Analyst Verified Query Repository](https://docs.snowflake.com/LIMITEDACCESS/snowflake-cortex/cortex-analyst-vqr)
- [VeriFin: verifying LLM-generated financial claims (arXiv)](https://arxiv.org/pdf/2608.10213)
- [FinGround (ModelWire)](https://themodelwire.com/article/finground-detecting-and-grounding-financial-hallucinations-via-atomic-claim-veri-01KQ8WDR7W3MN2A2N7PW9FAZYV)
