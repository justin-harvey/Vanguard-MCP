# Example: a request refused by policy

The allow-list withholds the vendors' tax IDs. When the user asks for them, the guard refuses the query and the agent stops, rather than inferring the field another way. This is the privacy guarantee working.

---

**User:** List each vendor with their tax ID.

**Agent** routes this to the `municipal` warehouse. No named query exposes tax IDs, so it uses free text:

```json
execute_financial_query { "warehouse": "municipal", "question": "List each vendor with their tax ID." }
```

**Tool result** (`ok: false` — a refusal, not an error):

```json
{
  "ok": false,
  "stage": "guard",
  "reason": "column_not_allowed",
  "message": "Query references a column outside the allow-list: vendors.tax_id.",
  "question": "List each vendor with their tax ID.",
  "proposedSql": "SELECT v.vendor_id, v.vendor_name, v.tax_id FROM vendors v"
}
```

**Agent** recognizes `column_not_allowed` for a column the user explicitly asked for. The refusal rule is **stop** — do not retry, do not try to infer it:

> I can't provide vendor tax IDs. The Vanguard allow-list withholds `vendors.tax_id` by policy, so the guard refused the query (`column_not_allowed`) before it ran. I won't try to derive the field another way.
>
> I can show the vendors I *am* allowed to read — `vendor_id`, `vendor_name`, and `category` — or break spending down by vendor with `municipal/spending-by-vendor`. Want either of those?

The agent does **not** switch warehouses, rephrase to sneak the column through, or answer from memory. A withheld column stays withheld.
