/**
 * Plain-English questions for the in-browser sandbox.
 *
 * There is no language model on the static demo page, so this is a small,
 * deterministic phrase router: it reads a question, resolves the vendors,
 * categories, budget codes and dates it mentions against the visitor's own
 * data, and picks ONE named query from sandbox-queries.js with its parameters.
 * It never writes SQL and never computes a figure. The answer sentence is
 * filled from the returned row values only, so every number in it is a value
 * the database produced, under a result hash.
 *
 * In the agent skill and the hosted dashboard the same step is done by the
 * model (run_canonical for a named query, or the guarded planner for an open
 * question); the guard, read-only execution, checks and audit chain after it
 * are identical.
 *
 * Pure: no DOM, no database. Tested in test/plain-english.test.js.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(\d{4}))?/g;
const WORD_STOP = new Set(['the', 'and', 'inc', 'llc', 'co', 'corp', 'company', 'supply', 'services', 'of']);

/** Example questions the page offers as chips; each one maps to a different query. */
export const EXAMPLE_QUESTIONS = [
    'How much did we pay North Fuel in April?',
    'Is the roads budget over its cap?',
    'Any duplicate invoices?',
    'What was the largest single payment?',
    'Who did we pay the most?',
    'Total spend in March 2026?',
];

export class PlainEnglishRefusal extends Error {
    constructor(message, suggestions = EXAMPLE_QUESTIONS.slice(0, 3)) {
        super(message);
        this.suggestions = suggestions;
    }
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
const singular = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const hasWord = (text, word) => new RegExp('(^|[^a-z0-9-])' + word.replace(/[-]/g, '\\-') + '($|[^a-z0-9-])').test(text);

/**
 * The entities a question can refer to, taken from the visitor's parsed rows.
 * This is vocabulary only (names and codes), never figures.
 */
export function vocabularyOf(expenditures, budgets) {
    const uniq = (xs) => [...new Set(xs.filter(Boolean))];
    const years = expenditures.map((e) => String(e.txn_date).slice(0, 4)).filter((y) => /^\d{4}$/.test(y));
    const counts = years.reduce((m, y) => m.set(y, (m.get(y) ?? 0) + 1), new Map());
    const defaultYear = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? String(new Date().getFullYear());
    return {
        vendors: uniq(expenditures.map((e) => e.vendor)),
        categories: uniq(expenditures.map((e) => e.category)),
        budgets: uniq([...budgets.map((b) => b.budget_code), ...expenditures.map((e) => e.budget_code)]),
        defaultYear,
    };
}

function findVendor(q, vendors) {
    // Full name first, then any distinctive word of a name ("Acme" → Acme Paving).
    const full = vendors.filter((v) => q.includes(norm(v))).sort((a, b) => b.length - a.length);
    if (full.length) return full[0];
    const hits = vendors.filter((v) => norm(v).split(' ').some((w) => w.length >= 4 && !WORD_STOP.has(w) && hasWord(q, w)));
    return hits.length === 1 ? hits[0] : null;
}
function findCategory(q, categories) {
    const words = q.split(' ').map(singular);
    return categories.find((c) => words.includes(singular(norm(c)))) ?? null;
}
function findBudget(q, budgets, category) {
    const exact = budgets.find((b) => hasWord(q, norm(b)));
    if (exact) return exact;
    // "the roads budget" → the one budget code that starts with that category.
    if (category) {
        const byPrefix = budgets.filter((b) => singular(norm(b).split('-')[0]) === singular(norm(category)));
        if (byPrefix.length === 1) return byPrefix[0];
    }
    const words = q.split(' ').map(singular);
    const byWord = budgets.filter((b) => words.includes(singular(norm(b).split('-')[0])));
    return byWord.length === 1 ? byWord[0] : null;
}

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(Number(y), m + 1, 0)).getUTCDate();
function monthIndex(token) {
    const t = token.slice(0, 3);
    return MONTH_SHORT.indexOf(t === 'sep' ? 'sep' : t);
}
function monthRange(y, m) {
    return { date_from: `${y}-${pad(m + 1)}-01`, date_to: `${y}-${pad(m + 1)}-${pad(lastDay(y, m))}` };
}

/** Resolve the date range a question mentions, or {} for none. */
export function datesOf(q, defaultYear) {
    const iso = [...q.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
    if (iso.length >= 2) return { date_from: iso[0] < iso[1] ? iso[0] : iso[1], date_to: iso[0] < iso[1] ? iso[1] : iso[0] };
    if (iso.length === 1) {
        if (/\b(since|after|from)\b/.test(q)) return { date_from: iso[0] };
        if (/\b(before|until|through|by)\b/.test(q)) return { date_to: iso[0] };
        return { date_from: iso[0], date_to: iso[0] };
    }
    const quarter = q.match(/\bq([1-4])\b(?:\s+(\d{4}))?/);
    if (quarter) {
        const y = quarter[2] ?? q.match(/\b(20\d{2})\b/)?.[1] ?? defaultYear;
        const first = (Number(quarter[1]) - 1) * 3;
        return { date_from: `${y}-${pad(first + 1)}-01`, date_to: `${y}-${pad(first + 3)}-${pad(lastDay(y, first + 2))}` };
    }
    const months = [...q.matchAll(MONTH_RE)].filter((m) => m[1] !== 'may' || /\b(in|of|during|since|before|until|through|to|and|from)\s+may\b/.test(q));
    if (months.length) {
        const yearAlone = q.match(/\b(20\d{2})\b/)?.[1];
        const ranges = months.map((m) => monthRange(m[2] ?? yearAlone ?? defaultYear, monthIndex(m[1])));
        if (ranges.length >= 2) return { date_from: ranges[0].date_from, date_to: ranges[ranges.length - 1].date_to };
        if (/\b(since|after|from)\b/.test(q)) return { date_from: ranges[0].date_from };
        if (/\b(before|until)\b/.test(q)) {
            const d = new Date(ranges[0].date_from + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() - 1);
            return { date_to: d.toISOString().slice(0, 10) };
        }
        return ranges[0];
    }
    const year = q.match(/\b(?:in|during|for)\s+(20\d{2})\b/)?.[1];
    if (year) return { date_from: `${year}-01-01`, date_to: `${year}-12-31` };
    return {};
}

/**
 * Map a plain-English question to one named query.
 *
 * @returns {{ query: string, args: object, reading: string }}
 * @throws {PlainEnglishRefusal} when no named query answers it
 */
export function interpret(question, vocab) {
    const q = norm(question);
    if (!q) throw new PlainEnglishRefusal('Type a question about the expenditures above.');
    if (/\b(delete|drop|update|insert|truncate|alter|remove|modify|overwrite|change)\b/.test(q)) {
        throw new PlainEnglishRefusal('Refused: the engine is read-only. It can answer questions about the data, never change it.');
    }
    const vendor = findVendor(q, vocab.vendors);
    const category = findCategory(q, vocab.categories);
    const budget = findBudget(q, vocab.budgets, category);
    const dates = datesOf(q, vocab.defaultYear);
    const withDates = (args) => ({ ...args, ...dates });

    if (/\b(duplicate|duplicates|duplicated|double|twice|more than once|paid again|same invoice)\b/.test(q)) {
        return { query: 'duplicate-invoices', args: {}, reading: 'exact-duplicate payments' };
    }
    if (/\b(over budget|overspen\w*|over (its|the|their) (cap|budget)|over cap|exceed\w*|remaining|left|headroom|under budget|within budget|cap|caps)\b/.test(q)
        || (/\bbudget/.test(q) && !vendor)) {
        if (budget) return { query: 'budget-status', args: { budget }, reading: `status of budget ${budget}` };
        return { query: 'budget-overspend', args: {}, reading: 'every budget code against its cap' };
    }
    if (/\b(largest|biggest|highest|most expensive|single largest|top payment|top invoice|max\w*)\b/.test(q) && !/\b(vendor|vendors|who|supplier)\b/.test(q)) {
        return { query: 'largest-payment', args: withDates({}), reading: 'the largest single payments' };
    }
    if (/\b(who|which vendor|top vendor|by vendor|per vendor|each vendor|vendors|suppliers)\b/.test(q) && !vendor) {
        return { query: 'spend-by-vendor', args: withDates({}), reading: 'spend per vendor' };
    }
    if (/\b(by category|per category|each category|categories|breakdown|break down)\b/.test(q)) {
        return { query: 'spend-by-category', args: withDates({}), reading: 'spend per category' };
    }
    if (vendor) return { query: 'vendor-total', args: withDates({ vendor }), reading: `total paid to ${vendor}` };
    if (category) return { query: 'category-total', args: withDates({ category }), reading: `total spend on ${category}` };
    if (budget) return { query: 'budget-status', args: { budget }, reading: `status of budget ${budget}` };
    if (/\b(total|spend|spent|spending|paid|pay|cost|costs|how much|expenditure\w*|outflow)\b/.test(q)) {
        return { query: 'total-spend', args: withDates({}), reading: 'total spend' };
    }
    throw new PlainEnglishRefusal(
        "No verified query answers that here. This browser demo maps questions onto a fixed set of named queries; with a model connected (the agent skill or the hosted dashboard), an open question is planned as guarded SQL instead, and anything it can't ground is refused the same way.",
    );
}

// ── the answer sentence, filled only from returned values ──────────────────
export function money(cents) {
    const n = Number(cents) / 100;
    return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;
export function rangeLabel(args) {
    const fmt = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    if (args.date_from && args.date_to) return args.date_from === args.date_to ? ` on ${fmt(args.date_from)}` : ` from ${fmt(args.date_from)} to ${fmt(args.date_to)}`;
    if (args.date_from) return ` since ${fmt(args.date_from)}`;
    if (args.date_to) return ` through ${fmt(args.date_to)}`;
    return '';
}

/**
 * The one-sentence answer. Returns { text, figure } where figure is the
 * headline value as the database returned it (for the big number on the card).
 */
export function answerFor(query, args, rows) {
    const r = rows[0];
    const when = rangeLabel(args);
    switch (query) {
        case 'vendor-total':
            return r
                ? { figure: money(r.amount_cents), text: `${r.vendor} was paid ${money(r.amount_cents)} across ${plural(r.invoice_count, 'invoice', 'invoices')}${when}.` }
                : { figure: money(0), text: `No payments to ${args.vendor}${when}.` };
        case 'category-total':
            return r
                ? { figure: money(r.amount_cents), text: `Spend on ${r.category} was ${money(r.amount_cents)} across ${plural(r.invoice_count, 'invoice', 'invoices')}${when}.` }
                : { figure: money(0), text: `No spend on ${args.category}${when}.` };
        case 'total-spend':
            return { figure: money(r?.amount_cents ?? 0), text: `Total spend${when} was ${money(r?.amount_cents ?? 0)} across ${plural(r?.invoice_count ?? 0, 'invoice', 'invoices')}.` };
        case 'budget-status':
            if (!r) return { figure: '—', text: `There is no budget code ${args.budget} in the caps list.` };
            return r.over_cents > 0
                ? { figure: money(r.over_cents) + ' over', text: `${r.budget_code} is over its cap: ${money(r.amount_cents)} spent against ${money(r.cap_cents)}, ${money(r.over_cents)} over.` }
                : { figure: money(r.remaining_cents) + ' left', text: `${r.budget_code} is within its cap: ${money(r.amount_cents)} spent of ${money(r.cap_cents)}, ${money(r.remaining_cents)} remaining.` };
        case 'budget-overspend': {
            const over = rows.filter((x) => x.amount_cents > x.cap_cents);
            if (!over.length) return { figure: 'None over', text: `All ${plural(rows.length, 'budget code is', 'budget codes are')} within their caps.` };
            const list = over.map((x) => `${x.budget_code} (${money(x.amount_cents)} spent against a ${money(x.cap_cents)} cap)`).join('; ');
            return { figure: `${over.length} over`, text: `${plural(over.length, 'budget code is', 'budget codes are')} over cap: ${list}.` };
        }
        case 'duplicate-invoices':
            if (!rows.length) return { figure: 'None', text: 'No exact-duplicate payments found.' };
            return {
                figure: plural(rows.length, 'possible duplicate', 'possible duplicates'),
                text: rows.map((x) => `${x.vendor} was paid ${money(x.amount_cents)} ${x.copies} times against ${x.budget_code}`).join('; ') + '. Confirm before treating as an error.',
            };
        case 'largest-payment': {
            if (!r) return { figure: '—', text: `No payments${when}.` };
            const tied = rows.filter((x) => x.amount_cents === r.amount_cents).length;
            return {
                figure: money(r.amount_cents),
                text: `The largest single payment${when} was ${money(r.amount_cents)} to ${r.vendor} on ${r.txn_date} (${r.budget_code})` + (tied > 1 ? `, tied with ${plural(tied - 1, 'other payment', 'other payments')} of the same amount.` : '.'),
            };
        }
        case 'spend-by-vendor':
            return r
                ? { figure: money(r.amount_cents), text: `${r.vendor} was paid the most${when}: ${money(r.amount_cents)} across ${plural(r.invoice_count, 'invoice', 'invoices')}, of ${plural(rows.length, 'vendor', 'vendors')} paid.` }
                : { figure: '—', text: `No payments${when}.` };
        case 'spend-by-category':
            return r
                ? { figure: money(r.amount_cents), text: `${r.category} is the largest category${when} at ${money(r.amount_cents)}, of ${plural(rows.length, 'category', 'categories')}.` }
                : { figure: '—', text: `No spend${when}.` };
        default:
            return { figure: '—', text: `${plural(rows.length, 'row', 'rows')} returned.` };
    }
}
