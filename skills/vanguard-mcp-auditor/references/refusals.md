# Refusals and self-correction

A refusal is the system working. It returns `stage`, `reason`, `message`, and usually `proposedSql`. You can't edit the SQL; Vanguard has no raw-SQL tool, by design. You can only ask again with a better question. Fix it yourself where the table below says to retry, **once**. If the retry is also refused, stop and report both refusals to the user.

Never switch warehouses to get an answer the right warehouse refused, and never answer from memory after a refusal.

| `reason` | Likely cause | What to do |
|---|---|---|
| `column_not_allowed` | The planner reached for a withheld column | If the user didn't ask for that column, **retry** and name the permitted columns from `vanguard://schema/{name}`. If they did ask for it (such as a vendor tax ID), **stop**: tell them the field is withheld by policy, and don't try to infer it another way. |
| `table_not_allowed` | The query read or JOINed a table outside the allow-list | Same rule as above. JOINs between allow-listed tables are fine; only the non-listed table is the problem. If the user asked about that table (`payroll` in the demo), **stop** and say it isn't exposed. |
| `wildcard_not_allowed` | `SELECT *` under a column allow-list | **Retry**, naming the specific fields you need. |
| `unparseable` | The planner produced SQL that won't parse | **Retry** with a more concrete question that names the table, the measure and the filter. |
| `empty` | The planner produced no SQL | **Retry** with a more concrete question. |
| `no_tables` | The query referenced no known table | **Retry** naming the table. |
| `multiple_statements` | The question bundled several asks | **Retry** as separate questions, one call each. |
| `timeout` (`stage: execute`) | Query exceeded the time budget | **Retry** narrower: aggregate, filter by year, grant or department. |
| `database_rejected` (`stage: execute`) | Guard passed it, SQLite refused it (bad column reference, type issue) | **Retry** once with exact column names from the schema resource. |
| `not_a_select` | The question asked for a non-SELECT statement | **Stop**. Vanguard is read-only, so say it can't change records. |
| `write_operation` | The question asked to change data | **Stop**. Vanguard is read-only, so say it can't change records. |
| `bad_scope` | Row-level scope could not be applied | **Stop** and report it. Don't route around it. |
| `warehouse_not_supported` (`stage: route`) | Free text on a canonical-only warehouse, or an unknown name | **Reroute** to `run_canonical` / `run_control` if one fits; otherwise tell the user what that warehouse supports. |

## Things that look like refusals but aren't

- **No LIMIT clause.** This is never refused. The guard adds `LIMIT 1000` and sets `limitInjected: true`.
- **A rounded figure.** Grounding accepts rounding to half a unit in the last place written ("36.7%" matches 0.3672), as well as cents shown as dollars and a ratio shown as a percent or basis points. A figure fails only when no returned value supports it, typically a percentage or difference the SQL never computed. Then the narrator retries once and, if it still fails, falls back to the mechanical summary (`fellBack: true`). The fix is to re-ask with the figure requested explicitly, so the SQL returns it.
- **An empty result.** `ok: true` with no rows means nothing matched the filter. Check that the filter values are right (for example `'G-402'`, not `402`) before you report "none".
