/**
 * The Law Firm Trust (IOLTA) ruleset, driven end to end through the real guard
 * against the shipped IOLTA demo warehouse.
 *
 * The five controls:
 *   three-way-reconciliation    compare: adjusted bank = journal = client ledgers
 *   negative-client-balances    empty:   no client ledger is overdrawn
 *   unsupported-fee-transfers   empty:   every fee transfer is invoice-backed
 *   firm-funds-in-trust         empty:   firm balance within the bank-charge allowance
 *   dormant-balances            empty:   no positive balance idle past the threshold
 *
 * Each is proven clean on the default seed and tripped by a targeted mutation
 * (or, for the thresholds, a parameter), so the flag paths are real, not
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
import { freshIoltaDb, IOLTA_ALLOWLIST } from './iolta-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULESET = join(here, '..', 'assets', 'iolta', 'ruleset.iolta-v1.json');

function warehouse(mutate) {
    const dbPath = freshIoltaDb(mutate);
    return loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: dbPath,
            [CUSTOM_ENV.allowlist]: IOLTA_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: RULESET,
        },
    });
}

const run = (w, name, args = {}) => runNamedQuery(w, name, args, { guard });

// ── the ruleset document ──────────────────────────────────────────────────

test('the IOLTA ruleset parses and declares its five controls', () => {
    const r = parseRuleset(JSON.parse(readFileSync(RULESET, 'utf8')));
    assert.equal(r.name, 'iolta');
    assert.equal(r.version, 'iolta-v1');
    assert.deepEqual(Object.keys(r.queries), [
        'three-way-reconciliation',
        'negative-client-balances',
        'unsupported-fee-transfers',
        'firm-funds-in-trust',
        'dormant-balances',
    ]);
});

test('every IOLTA query and check SQL passes the guard (validated at load)', () => {
    const w = warehouse();
    // five query SQLs + one total_matches check SQL = six guarded statements
    assert.equal(validateNamedQueries(w, guard), 6);
    assert.equal(w.ruleset.version, 'iolta-v1');
});

// ── clean seed: every control passes ─────────────────────────────────────────

test('on the clean seed all five controls pass', () => {
    const w = warehouse();

    const recon = run(w, 'three-way-reconciliation');
    assert.equal(recon.integrity, 'pass');
    assert.equal(recon.findings, 0);
    assert.equal(recon.rows[0].adjusted_bank_cents, 570000);
    assert.equal(recon.rows[0].journal_balance_cents, 570000);
    assert.equal(recon.rows[0].client_ledger_sum_cents, 570000, 'all three figures tie');

    for (const name of ['negative-client-balances', 'unsupported-fee-transfers', 'firm-funds-in-trust', 'dormant-balances']) {
        const out = run(w, name);
        assert.equal(out.integrity, 'pass', `${name} integrity`);
        assert.equal(out.findings, 0, `${name} findings`);
        assert.equal(out.rows.length, 0, `${name} rows`);
    }
});

test('the reconciliation reads the latest snapshot by date, not the largest', () => {
    // S-01 (statement 160,000) is earlier; S-02 (adjusted 570,000) is latest.
    const w = warehouse();
    assert.equal(run(w, 'three-way-reconciliation').rows[0].adjusted_bank_cents, 570000);
});

// ── each control tripped ─────────────────────────────────────────────────────

test('three-way-reconciliation flags a bank-to-journal break', () => {
    // Overstate outstanding checks so adjusted bank (530,000) < journal (570,000).
    const w = warehouse((db) => db.exec("UPDATE trust_bank_snapshots SET outstanding_checks_cents = 90000 WHERE snapshot_id = 'S-02'"));
    const out = run(w, 'three-way-reconciliation');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'bank-ties-journal');
    assert.equal(check.status, 'flag');
    assert.equal(out.rows[0].adjusted_bank_cents, 530000);
});

test('three-way-reconciliation flags unidentified trust money (journal != client ledgers)', () => {
    // Strip a deposit's client_id: it stays in the journal but leaves the client ledgers.
    const w = warehouse((db) => db.exec("UPDATE trust_journal SET client_id = NULL WHERE entry_id = 'T-0001'"));
    const out = run(w, 'three-way-reconciliation');
    assert.equal(out.findings, 1);
    const bank = out.checks.find((c) => c.id === 'bank-ties-journal');
    const clients = out.checks.find((c) => c.id === 'journal-ties-clients');
    assert.equal(bank.status, 'pass', 'the bank still ties the journal');
    assert.equal(clients.status, 'flag');
    assert.equal(out.rows[0].client_ledger_sum_cents, 70000);
    // The integrity recompute agrees with the query's own client-ledger figure.
    assert.equal(out.checks.find((c) => c.id === 'client-ledgers-recompute').status, 'pass');
});

test('negative-client-balances flags an overdrawn client ledger', () => {
    // Blow C-100's disbursement past its deposits, so its ledger goes negative.
    const w = warehouse((db) => db.exec("UPDATE trust_journal SET amount_cents = 600000 WHERE entry_id = 'T-0002'"));
    const out = run(w, 'negative-client-balances');
    assert.equal(out.findings, 1);
    const check = out.checks.find((c) => c.id === 'no-negative-balances');
    assert.equal(check.status, 'flag');
    assert.deepEqual(check.detail.rows, ['C-100']);
    assert.equal(out.rows[0].balance_cents, -200000);
});

test('unsupported-fee-transfers flags a transfer with no invoice', () => {
    const w = warehouse((db) => db.exec("UPDATE trust_journal SET invoice_id = NULL WHERE entry_id = 'T-0003'"));
    const out = run(w, 'unsupported-fee-transfers');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'no-unsupported-transfers').status, 'flag');
    assert.deepEqual(out.rows.map((r) => r.entry_id), ['T-0003']);
});

test('unsupported-fee-transfers flags a transfer larger than its invoice', () => {
    // INV-2 is 60,000; raise the transfer to 70,000.
    const w = warehouse((db) => db.exec("UPDATE trust_journal SET amount_cents = 70000 WHERE entry_id = 'T-0011'"));
    const out = run(w, 'unsupported-fee-transfers');
    assert.equal(out.findings, 1);
    assert.deepEqual(out.rows.map((r) => r.entry_id), ['T-0011']);
    assert.equal(out.rows[0].transfer_cents, 70000);
    assert.equal(out.rows[0].invoice_amount_cents, 60000);
});

test('firm-funds-in-trust flags a firm balance above the default allowance', () => {
    // Raise the firm buffer from 20,000 to 40,000, past the 25,000 default.
    const w = warehouse((db) => db.exec("UPDATE trust_journal SET amount_cents = 40000 WHERE entry_id = 'T-0030'"));
    const out = run(w, 'firm-funds-in-trust');
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'no-excess-firm-funds').status, 'flag');
    assert.deepEqual(out.rows.map((r) => r.client_id), ['FIRM-BUFFER']);
    assert.equal(out.rows[0].firm_balance_cents, 40000);
});

test('the firm-funds allowance parameter suppresses a balance within a larger allowance', () => {
    const w = warehouse((db) => db.exec("UPDATE trust_journal SET amount_cents = 40000 WHERE entry_id = 'T-0030'"));
    const out = run(w, 'firm-funds-in-trust', { max_firm_cents: 100000 });
    assert.equal(out.findings, 0);
    assert.equal(out.rows.length, 0);
});

test('dormant-balances flags an idle positive balance at a tighter threshold', () => {
    // The Chen ledger (C-300) is idle ~146 days; the 365 default clears it,
    // a 90-day threshold surfaces it. No data mutation needed.
    const w = warehouse();
    assert.equal(run(w, 'dormant-balances').findings, 0, 'clean at the 365 default');
    const out = run(w, 'dormant-balances', { dormant_days: 90 });
    assert.equal(out.findings, 1);
    assert.equal(out.checks.find((c) => c.id === 'no-dormant-balances').status, 'flag');
    assert.deepEqual(out.rows.map((r) => r.client_id), ['C-300']);
    assert.equal(out.rows[0].balance_cents, 100000);
    assert.equal(out.rows[0].idle_days, 146);
});

// ── signature status ─────────────────────────────────────────────────────────

test('the bundled IOLTA ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(RULESET);
    assert.equal(r.signature.status, 'signed');
    const trustedKeyId = keyIdOf(createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8')));
    assert.equal(r.signature.signedBy, trustedKeyId);
});

test('a result from the signed IOLTA ruleset reports its signature status', () => {
    const w = warehouse();
    assert.equal(w.ruleset.status, 'signed');
    const out = run(w, 'negative-client-balances');
    assert.equal(out.entry.ruleset.version, 'iolta-v1');
    assert.equal(out.entry.ruleset.status, 'signed');
});
