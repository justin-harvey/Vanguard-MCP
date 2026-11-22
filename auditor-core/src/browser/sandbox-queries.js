/**
 * The named queries of the "bring your own expenditures" sandbox.
 *
 * The visitor edits rows, never the schema, so every query here lines up with
 * the two fixed tables (expenditures, budgets). The plain-English box
 * (plain-english.js) only ever picks one of these and fills its parameters; it
 * never writes SQL, so every figure in an answer comes from one of these
 * statements, run through the real guard, the read-only connection and the
 * audit chain.
 *
 * Optional parameters left out are bound as NULL, so date filters are written
 * "(:p IS NULL OR col >= :p)". Dates are ISO text (YYYY-MM-DD), which compare
 * correctly as strings.
 */

const DATE_PARAMS = {
    date_from: { type: 'string', description: 'ISO date, inclusive; omit for no lower bound' },
    date_to: { type: 'string', description: 'ISO date, inclusive; omit for no upper bound' },
};
const DATE_WHERE = '(:date_from IS NULL OR e.txn_date >= :date_from) AND (:date_to IS NULL OR e.txn_date <= :date_to)';

export const SANDBOX_QUERIES = {
    'budget-overspend': {
        description: 'Each budget code: its cap, spend to date and remaining budget; flags any code over its cap.',
        params: {},
        sql: 'SELECT b.budget_code, b.cap_cents, COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) AS amount_cents, b.cap_cents - COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) AS remaining_cents FROM budgets b ORDER BY b.budget_code',
        checks: [
            { id: 'one-row-per-code', type: 'unique', columns: ['budget_code'] },
            { id: 'within-budget', type: 'compare', left: 'amount_cents', op: '<=', right: 'cap_cents', key: 'budget_code', message: 'Spending against this budget code exceeds its cap.' },
        ],
    },
    'budget-status': {
        description: 'One budget code: its cap, spend to date, remaining budget and any amount over the cap.',
        params: { budget: { type: 'string', required: true, description: 'a budget code, e.g. roads-26' } },
        sql: 'SELECT b.budget_code, b.cap_cents, COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) AS amount_cents, b.cap_cents - COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) AS remaining_cents, CASE WHEN COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) > b.cap_cents THEN COALESCE((SELECT SUM(e.amount_cents) FROM expenditures e WHERE e.budget_code = b.budget_code), 0) - b.cap_cents ELSE 0 END AS over_cents FROM budgets b WHERE b.budget_code = :budget',
        checks: [
            { id: 'one-row-per-code', type: 'unique', columns: ['budget_code'] },
            { id: 'within-budget', type: 'compare', left: 'amount_cents', op: '<=', right: 'cap_cents', key: 'budget_code', message: 'Spending against this budget code exceeds its cap.' },
        ],
    },
    'duplicate-invoices': {
        description: 'Exact-duplicate payments: the same vendor paid the same amount against the same budget code more than once.',
        params: {},
        sql: 'SELECT e.vendor, e.category, e.budget_code, e.amount_cents, COUNT(e.expenditure_id) AS copies FROM expenditures e GROUP BY e.vendor, e.category, e.budget_code, e.amount_cents HAVING COUNT(e.expenditure_id) > 1 ORDER BY e.amount_cents DESC, e.vendor',
        checks: [
            { id: 'no-duplicate-payments', type: 'empty', key: 'vendor', message: 'This vendor was paid the same amount against the same budget code more than once; confirm it is not a duplicate payment.' },
        ],
    },
    'spend-by-category': {
        description: 'Total spend and invoice count per category.',
        params: { ...DATE_PARAMS },
        sql: `SELECT e.category, COUNT(e.expenditure_id) AS invoice_count, SUM(e.amount_cents) AS amount_cents FROM expenditures e WHERE ${DATE_WHERE} GROUP BY e.category ORDER BY SUM(e.amount_cents) DESC, e.category`,
        checks: [
            { id: 'one-row-per-category', type: 'unique', columns: ['category'] },
            { id: 'total-reconciles', type: 'total_matches', column: 'amount_cents', sql: `SELECT COALESCE(SUM(e.amount_cents), 0) AS total FROM expenditures e WHERE ${DATE_WHERE}` },
        ],
    },
    'spend-by-vendor': {
        description: 'Total paid and invoice count per vendor, largest first.',
        params: { ...DATE_PARAMS },
        sql: `SELECT e.vendor, COUNT(e.expenditure_id) AS invoice_count, SUM(e.amount_cents) AS amount_cents FROM expenditures e WHERE ${DATE_WHERE} GROUP BY e.vendor ORDER BY SUM(e.amount_cents) DESC, e.vendor`,
        checks: [
            { id: 'one-row-per-vendor', type: 'unique', columns: ['vendor'] },
            { id: 'total-reconciles', type: 'total_matches', column: 'amount_cents', sql: `SELECT COALESCE(SUM(e.amount_cents), 0) AS total FROM expenditures e WHERE ${DATE_WHERE}` },
        ],
    },
    'vendor-total': {
        description: 'Total paid to one vendor and the number of invoices, optionally within a date range.',
        params: { vendor: { type: 'string', required: true, description: 'vendor name exactly as it appears in the data' }, ...DATE_PARAMS },
        sql: `SELECT e.vendor, COUNT(e.expenditure_id) AS invoice_count, SUM(e.amount_cents) AS amount_cents FROM expenditures e WHERE e.vendor = :vendor AND ${DATE_WHERE} GROUP BY e.vendor`,
        checks: [
            { id: 'one-row-per-vendor', type: 'unique', columns: ['vendor'] },
            { id: 'total-reconciles', type: 'total_matches', column: 'amount_cents', sql: `SELECT COALESCE(SUM(e.amount_cents), 0) AS total FROM expenditures e WHERE e.vendor = :vendor AND ${DATE_WHERE}` },
        ],
    },
    'category-total': {
        description: 'Total spend in one category and the number of invoices, optionally within a date range.',
        params: { category: { type: 'string', required: true, description: 'category exactly as it appears in the data' }, ...DATE_PARAMS },
        sql: `SELECT e.category, COUNT(e.expenditure_id) AS invoice_count, SUM(e.amount_cents) AS amount_cents FROM expenditures e WHERE e.category = :category AND ${DATE_WHERE} GROUP BY e.category`,
        checks: [
            { id: 'one-row-per-category', type: 'unique', columns: ['category'] },
            { id: 'total-reconciles', type: 'total_matches', column: 'amount_cents', sql: `SELECT COALESCE(SUM(e.amount_cents), 0) AS total FROM expenditures e WHERE e.category = :category AND ${DATE_WHERE}` },
        ],
    },
    'total-spend': {
        description: 'Total spend and invoice count, optionally within a date range.',
        params: { ...DATE_PARAMS },
        sql: `SELECT COUNT(e.expenditure_id) AS invoice_count, COALESCE(SUM(e.amount_cents), 0) AS amount_cents FROM expenditures e WHERE ${DATE_WHERE}`,
        checks: [],
    },
    'largest-payment': {
        description: 'The largest single payments, optionally within a date range (top three, so ties are visible).',
        params: { ...DATE_PARAMS },
        sql: `SELECT e.txn_date, e.vendor, e.category, e.budget_code, e.amount_cents FROM expenditures e WHERE ${DATE_WHERE} ORDER BY e.amount_cents DESC, e.expenditure_id LIMIT 3`,
        checks: [],
    },
};
