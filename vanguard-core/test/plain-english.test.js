/**
 * The sandbox's plain-English router (src/browser/plain-english.js).
 *
 * It must pick the right named query and parameters, refuse what it can't map
 * (and anything that would change data), and build answer sentences only from
 * values in the returned rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret, answerFor, vocabularyOf, datesOf, PlainEnglishRefusal, EXAMPLE_QUESTIONS } from '../src/browser/plain-english.js';
import { SANDBOX_QUERIES } from '../src/browser/sandbox-queries.js';

const EXP = [
    { txn_date: '2026-03-02', vendor: 'Acme Paving', category: 'roads', amount_cents: 4200000, budget_code: 'roads-26' },
    { txn_date: '2026-03-09', vendor: 'Acme Paving', category: 'roads', amount_cents: 4200000, budget_code: 'roads-26' },
    { txn_date: '2026-03-11', vendor: 'Bay Office Supply', category: 'admin', amount_cents: 187500, budget_code: 'admin-26' },
    { txn_date: '2026-04-01', vendor: 'North Fuel', category: 'fleet', amount_cents: 910000, budget_code: 'fleet-26' },
    { txn_date: '2026-04-04', vendor: 'North Fuel', category: 'fleet', amount_cents: 1820000, budget_code: 'fleet-26' },
];
const BUD = [{ budget_code: 'roads-26', cap_cents: 6000000 }, { budget_code: 'admin-26', cap_cents: 500000 }, { budget_code: 'fleet-26', cap_cents: 3000000 }];
const V = vocabularyOf(EXP, BUD);

test('vocabulary comes from the data, with the dominant year', () => {
    assert.deepEqual(V.vendors, ['Acme Paving', 'Bay Office Supply', 'North Fuel']);
    assert.equal(V.defaultYear, '2026');
});

test('routes questions to the right named query and parameters', () => {
    const cases = [
        ['How much did we pay North Fuel in April?', 'vendor-total', { vendor: 'North Fuel', date_from: '2026-04-01', date_to: '2026-04-30' }],
        ['what did acme cost us', 'vendor-total', { vendor: 'Acme Paving' }],
        ['Is the roads budget over its cap?', 'budget-status', { budget: 'roads-26' }],
        ['How much is left in fleet-26?', 'budget-status', { budget: 'fleet-26' }],
        ['Which budgets are overspent?', 'budget-overspend', {}],
        ['Any duplicate invoices?', 'duplicate-invoices', {}],
        ['Did we pay anyone twice?', 'duplicate-invoices', {}],
        ['What was the largest single payment?', 'largest-payment', {}],
        ['Who did we pay the most?', 'spend-by-vendor', {}],
        ['Spend by category in Q1', 'spend-by-category', { date_from: '2026-01-01', date_to: '2026-03-31' }],
        ['Total spend in March 2026?', 'total-spend', { date_from: '2026-03-01', date_to: '2026-03-31' }],
        ['How much went on admin?', 'category-total', { category: 'admin' }],
        ['total paid between 2026-03-05 and 2026-04-02', 'total-spend', { date_from: '2026-03-05', date_to: '2026-04-02' }],
    ];
    for (const [q, query, args] of cases) {
        const plan = interpret(q, V);
        assert.equal(plan.query, query, q);
        assert.deepEqual(plan.args, args, q);
        assert.ok(SANDBOX_QUERIES[plan.query], `${plan.query} is a real named query`);
        for (const k of Object.keys(plan.args)) assert.ok(k in SANDBOX_QUERIES[plan.query].params, `${q}: ${k} is a declared param`);
    }
});

test('every example chip maps to a query', () => {
    for (const q of EXAMPLE_QUESTIONS) assert.ok(SANDBOX_QUERIES[interpret(q, V).query], q);
});

test('refuses writes and unmappable questions', () => {
    assert.throws(() => interpret('delete the Acme rows', V), PlainEnglishRefusal);
    assert.throws(() => interpret('write me a poem', V), PlainEnglishRefusal);
    assert.throws(() => interpret('   ', V), PlainEnglishRefusal);
});

test('dates: since / before / a lone "may" is not a month', () => {
    assert.deepEqual(datesOf('since april', '2026'), { date_from: '2026-04-01' });
    assert.deepEqual(datesOf('before april', '2026'), { date_to: '2026-03-31' });
    assert.deepEqual(datesOf('may i see the total', '2026'), {});
    assert.deepEqual(datesOf('total in may', '2026'), { date_from: '2026-05-01', date_to: '2026-05-31' });
});

test('answer sentences use only values present in the rows', () => {
    const a = answerFor('vendor-total', { vendor: 'North Fuel' }, [{ vendor: 'North Fuel', invoice_count: 2, amount_cents: 2730000 }]);
    assert.equal(a.text, 'North Fuel was paid $27,300.00 across 2 invoices.');
    const b = answerFor('budget-status', { budget: 'roads-26' }, [{ budget_code: 'roads-26', cap_cents: 6000000, amount_cents: 8400000, remaining_cents: -2400000, over_cents: 2400000 }]);
    assert.match(b.text, /over its cap: \$84,000\.00 spent against \$60,000\.00, \$24,000\.00 over/);
    const c = answerFor('largest-payment', {}, [
        { txn_date: '2026-03-02', vendor: 'Acme Paving', category: 'roads', budget_code: 'roads-26', amount_cents: 4200000 },
        { txn_date: '2026-03-09', vendor: 'Acme Paving', category: 'roads', budget_code: 'roads-26', amount_cents: 4200000 },
    ]);
    assert.match(c.text, /tied with 1 other payment/);
});
