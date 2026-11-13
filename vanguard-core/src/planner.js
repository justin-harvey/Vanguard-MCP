/**
 * The planner, natural language in, SQL out.
 *
 * This is the only place a model is asked to produce something, and it is
 * asked for exactly one thing: a SELECT statement. It is never shown a row of
 * data and never asked for a figure, which means at this stage it is not
 * merely discouraged from inventing numbers, it has none to invent from.
 *
 * The output is constrained with a schema rather than parsed out of prose. A
 * model asked for "just the SQL" will, often enough to matter, return a
 * sentence of preamble, a fenced block, or a trailing explanation, and the
 * regex that strips those is another thing to get wrong. Structured output
 * makes the shape the API's problem.
 *
 * Whatever comes back still goes through the guard. The prompt below asks for
 * a read-only single statement over the warehouse's allow-listed tables; the
 * guard *enforces* that.
 * Prompt text is a request, not a control.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ALLOWED_TABLES } from './guard.js';

export const MODEL = 'claude-opus-4-8';

const PlanSchema = z.object({
    sql: z.string().describe('A single SQLite SELECT statement answering the question.'),
    interpretation: z
        .string()
        .describe(
            'One or two sentences on how the question was interpreted: which metric definition was used, ' +
                'what period was assumed, any ambiguity resolved. No figures, you have not seen the data.',
        ),
});

const SCHEMA_DESCRIPTION = `
customers(id, name, cohort_month TEXT 'YYYY-MM', acquisition_channel, country, created_at)
subscriptions(id, customer_id -> customers.id, plan 'starter'|'growth'|'enterprise', mrr_cents INTEGER, started_at, canceled_at NULL-if-active)
mrr_movements(id, customer_id -> customers.id, month TEXT 'YYYY-MM', movement 'new'|'expansion'|'contraction'|'churn', amount_cents INTEGER)
acquisition_spend(id, channel, month TEXT 'YYYY-MM', spend_cents INTEGER, customers_acquired INTEGER)

Notes:
- All money is INTEGER CENTS. Do not divide by 100 in SQL unless the question asks for a
  display value; the caller handles presentation. If you do convert, name the column so the
  unit is obvious (e.g. mrr_usd).
- 'contraction' and 'churn' amounts are stored NEGATIVE, so MRR for a month is
  SUM(amount_cents) over mrr_movements, and running MRR is a window sum over months.
- Cohort means customers.cohort_month.
- Data covers 2025-06 through 2025-11 only.
`.trim();

/**
 * Build the planner's system prompt for a warehouse. With no argument this is
 * the SaaS prompt, byte for byte; a custom warehouse supplies its own domain,
 * schema text and allow-list.
 *
 * @param {object} [schema]
 * @param {string} [schema.domain] what the data is, e.g. "municipal budget data"
 * @param {string} [schema.schemaDescription] tables, columns and notes
 * @param {readonly string[]} [schema.allowedTables]
 * @param {boolean} [schema.columnRestricted] a column allow-list is in force
 * @returns {string}
 */
export function buildSystemPrompt({
    domain = 'SaaS finance data',
    schemaDescription = SCHEMA_DESCRIPTION,
    allowedTables = ALLOWED_TABLES,
    columnRestricted = false,
} = {}) {
    const columnRule = columnRestricted
        ? '\n- Reference only the columns listed in the schema. Other columns exist but are not permitted,\n  and SELECT * is refused.'
        : '';
    return `
You translate questions about ${domain} into SQLite SELECT statements.

Schema:
${schemaDescription}

Rules:
- Emit exactly ONE statement. It must be a SELECT. No semicolons, no CTE that wraps a write,
  no PRAGMA, no ATTACH.
- Read only from: ${allowedTables.join(', ')}. Nothing else exists, including sqlite_master.${columnRule}
- Prefer explicit column names over SELECT *, so the lineage record is meaningful.
- Include ORDER BY when the answer has a natural order; a stable order makes the result
  reproducible.
- Return at most a few hundred rows. Aggregate rather than dumping raw rows.
- Compute EVERY figure the answer will state INSIDE this query, returned as its own column.
  That includes derived figures: deltas, period-over-period growth, ratios, retention,
  spreads, averages. Do not leave arithmetic for the narration to perform, a number the
  query did not return cannot be verified against the data and will be rejected. For a
  "how much did X grow" question, return the start value, the end value, AND the computed
  change (and growth %, if asked) as separate columns. Round percentages/ratios in SQL to the
  precision the answer will quote (e.g. ROUND((end - start) * 100.0 / start, 1) AS growth_pct).
- If the question cannot be answered from this schema, still return your best SELECT and say
  so plainly in the interpretation field.
`.trim();
}

const SYSTEM_PROMPT = buildSystemPrompt();

export class PlanningFailed extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'PlanningFailed';
        this.cause = cause;
    }
}

/**
 * Ask the model for a SQL plan.
 *
 * @param {string} question
 * @param {object} [options]
 * @param {Anthropic} [options.client]
 * @param {string} [options.model]
 * @param {object|null} [options.schema] a warehouse's planner schema (see
 *   buildSystemPrompt); null plans against the SaaS warehouse
 * @returns {Promise<{ sql: string, interpretation: string, model: string }>}
 */
export async function plan(question, { client = new Anthropic(), model = MODEL, schema = null } = {}) {
    let response;
    try {
        response = await client.messages.parse({
            model,
            max_tokens: 16000,
            system: schema ? buildSystemPrompt(schema) : SYSTEM_PROMPT,
            thinking: { type: 'adaptive' },
            messages: [{ role: 'user', content: question }],
            output_config: { format: zodOutputFormat(PlanSchema) },
        });
    } catch (error) {
        // The SDK raises a plain Error (not AuthenticationError) when it
        // cannot find any credential at all, so match on that first.
        if (/Could not resolve authentication|apiKey or authToken/i.test(error?.message ?? '')) {
            throw new PlanningFailed(
                'No Anthropic credential found. Set ANTHROPIC_API_KEY, or run `ant auth login`. ' +
                    'Everything except planning and narration works without one, try `vanguard explain "SELECT ..."`.',
                error,
            );
        }
        if (error instanceof Anthropic.AuthenticationError) {
            throw new PlanningFailed(
                'No usable Anthropic credential. Set ANTHROPIC_API_KEY or run `ant auth login`.',
                error,
            );
        }
        if (error instanceof Anthropic.RateLimitError) {
            throw new PlanningFailed('Rate limited by the Anthropic API; retry shortly.', error);
        }
        if (error instanceof Anthropic.APIError) {
            throw new PlanningFailed(`Anthropic API error ${error.status}: ${error.message}`, error);
        }
        throw error;
    }

    // A refusal is a normal response, not an exception, check before reading.
    if (response.stop_reason === 'refusal') {
        throw new PlanningFailed(
            `The model declined to answer (${response.stop_details?.category ?? 'unspecified'}).`,
        );
    }

    const parsed = response.parsed_output;
    if (!parsed?.sql) {
        throw new PlanningFailed('The model returned no SQL.');
    }

    return { sql: parsed.sql, interpretation: parsed.interpretation ?? '', model };
}
