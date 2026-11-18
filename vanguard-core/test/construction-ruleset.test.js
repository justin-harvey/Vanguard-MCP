/**
 * The Construction Contracts ruleset, driven end to end through the real guard
 * against the shipped construction demo warehouse.
 *
 * The six controls:
 *   wip-schedule                 total_matches: earned revenue ties to GL revenue
 *   billings-tie-out             compare (=):   over/underbillings tie to the balance sheet
 *   loss-jobs                    empty:         no job's estimated cost exceeds its contract
 *   margin-fade                  empty (FLAG):  no job faded more than the tolerance
 *   retainage-reconciles         compare (=):   carried receivable = withheld - released
 *   payments-without-lien-waiver empty:         every sub payment carries a waiver
 *
 * Each is proven clean on the default seed and tripped by a targeted mutation
 * (or, for the fade window, a parameter), so the flag paths are real, not
 * asserted. The ruleset is also validated statement by statement (every query
 * and check SQL passes the guard).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicKey } from 'node:crypto';
import { parseRuleset, loadRuleset, CIVIC_CHAIN_PUBKEY_PATH } from '../src/ruleset.js';
import { keyIdOf } from '../src/signing.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { runNamedQuery, validateNamedQueries } from '../src/named-run.js';
import { guard } from '../src/guard.js';
import { freshConstructionDb, CONSTRUCTION_ALLOWLIST } from './construction-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'construction', 'ruleset.construction-v1.json');

function warehouse(mutate) {
    const dbPath = freshConstructionDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: CONSTRUCTION_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the construction ruleset parses and declares its six controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'construction');
    assert.equal(r.version, 'construction-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'wip-schedule',
        'billings-tie-out',
        'loss-jobs',
        'margin-fade',
        'retainage-reconciles',
        'payments-without-lien-waiver',
    ]);
});

test('every construction query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // six query SQLs + one total_matches check SQL (wip-schedule) = seven guarded statements
    assert.equal(validateNamedQueries(w, guard), 7);
    assert.equal(w.ruleset.version, 'construction-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all six controls pass', () => {
    const w = warehouse();

    // the three empty-finding controls return no offending rows
    for (const name of ['loss-jobs', 'margin-fade', 'payments-without-lien-waiver']) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
        assert.equal(out.rows.length, 0, `${name} returns no offending rows`);
    }

    const wip = run(w, 'wip-schedule');
    assert.equal(wip.integrity, 'pass');
    assert.equal(wip.findings, 0);
    assert.equal(wip.rows.length, 3, 'one row per job');
    assert.equal(wip.checks.find((c) => c.id === 'earned-ties-gl').detail.total, 170000000);
    assert.equal(wip.rows.find((r) => r.job_id === 'J-100').earned_revenue_cents, 100000000);
    assert.equal(wip.rows.find((r) => r.job_id === 'J-100').percent_complete_bps, 5000);
    assert.equal(wip.rows.find((r) => r.job_id === 'J-100').overbilling_cents, 10000000);
    assert.equal(wip.rows.find((r) => r.job_id === 'J-200').underbilling_cents, 4000000);

    const billings = run(w, 'billings-tie-out');
    assert.equal(billings.integrity, 'pass');
    assert.equal(billings.findings, 0);
    assert.equal(billings.rows.length, 1);
    assert.equal(billings.rows[0].overbillings_cents, 10000000);
    assert.equal(billings.rows[0].underbillings_cents, 4000000);

    const retainage = run(w, 'retainage-reconciles');
    assert.equal(retainage.integrity, 'pass');
    assert.equal(retainage.findings, 0);
    assert.equal(retainage.rows.length, 3, 'one row per job');
});

// ── each control tripped ─────────────────────────────────────────────────────

test('wip-schedule integrity flags when earned revenue no longer ties to the GL', () => {
    // Drop a GL revenue entry so the recognized total no longer equals the
    // earned total the schedule computes.
    const w = warehouse((db) => db.exec("UPDATE gl_revenue SET amount_cents = 1 WHERE entry_id = 'GLR-1'"));
    const out = run(w, 'wip-schedule');
    assert.equal(out.integrity, 'flag', 'the GL tie no longer holds');
    const check = out.checks.find((c) => c.id === 'earned-ties-gl');
    assert.equal(check.status, 'flag');
    assert.equal(check.detail.resultTotal, 170000000);
});

test('billings-tie-out flags when the balance-sheet contract liability does not tie', () => {
    const w = warehouse((db) =>
        db.exec("UPDATE balance_sheet_balances SET balance_cents = 999 WHERE account = 'CONTRACT_LIABILITY'"),
    );
    const out = run(w, 'billings-tie-out');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'overbillings-tie-liability');
    assert.equal(check.status, 'flag');
    assert.equal(out.checks.find((c) => c.id === 'underbillings-tie-asset').status, 'pass');
});

test('loss-jobs flags a job whose estimated cost exceeds its contract value', () => {
    // Raise J-100's estimated cost to 2,500,000 against its 2,000,000 contract.
    const w = warehouse((db) => db.exec("UPDATE jobs SET estimated_cost_cents = 250000000 WHERE job_id = 'J-100'"));
    const out = run(w, 'loss-jobs');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-loss-jobs');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['J-100']);
    assert.equal(out.rows.find((r) => r.job_id === 'J-100').estimated_loss_cents, 50000000);
});

test('margin-fade flags a job whose margin fell past the window, and a wider window clears it', () => {
    // Raise J-100's estimated cost to 1,900,000: current margin 500 bps against
    // the latest snapshot's 2100 bps is a 1600-bps fade, past the 300 default.
    const w = warehouse((db) => db.exec("UPDATE jobs SET estimated_cost_cents = 190000000 WHERE job_id = 'J-100'"));
    const out = run(w, 'margin-fade');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'margin-holds');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['J-100']);
    const row = out.rows.find((r) => r.job_id === 'J-100');
    assert.equal(row.fade_bps, 1600);
    assert.equal(row.prior_snapshot_date, '2026-06-30', 'the latest snapshot is used, not the older one');
    // A 2000-bps tolerance is wider than the 1600-bps fall, so it clears.
    assert.equal(run(w, 'margin-fade', { fade_bps: 2000 }).findings, 0, 'inside a 2000-bps window');
});

test('retainage-reconciles flags a job whose carried receivable does not tie', () => {
    const w = warehouse((db) => db.exec("UPDATE retainage SET receivable_cents = 12345 WHERE job_id = 'J-100'"));
    const out = run(w, 'retainage-reconciles');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'receivable-ties');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['J-100']);
});

test('payments-without-lien-waiver flags a payment released with no waiver on file', () => {
    const w = warehouse((db) => db.exec("UPDATE sub_payments SET lien_waiver_received = 0 WHERE payment_id = 'SP-2'"));
    const out = run(w, 'payments-without-lien-waiver');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'waivers-on-file');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['SP-2']);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled construction ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed construction ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'loss-jobs');
    assert.equal(out.entry.ruleset.version, 'construction-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
