/**
 * The acceptance gate for the in-browser demo (S7B).
 *
 * The product claim is that a visitor's browser runs the *same* engine a buyer
 * runs, with the *same* result hashes. This test runs each case through both:
 *
 *   Node path    runNamedQuery, the real guard, node:sqlite, node:crypto hashing
 *   browser path createDemoEngine, the real guard, WASM SQLite (sql.js), the
 *                dependency-free pure-JS SHA-256
 *
 * and asserts rows, checks, integrity, findings, the executed SQL and the
 * result hash all agree. If this fails, the demo has drifted from the engine.
 *
 * It also pins the audit-chain behaviour the demo depends on: three runs build
 * an intact three-entry chain, and mutating an entry is caught at its index.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import initSqlJs from 'sql.js';
import { guard, SqlRejected } from '../src/guard.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { runNamedQuery } from '../src/named-run.js';
import { createDemoEngine } from '../src/browser/engine.js';
import { sqljsAdapter } from '../src/browser/sqlite-adapter.js';
import { guardOptionsFor } from '../src/named-core.js';
import { freshMunicipalDb, MUNICIPAL_SQL, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';

const require = createRequire(import.meta.url);
const SQLJS_DIST = dirname(require.resolve('sql.js'));

const ALLOWLIST_DOC = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST, 'utf8'));
const SEED_SQL = readFileSync(MUNICIPAL_SQL, 'utf8');

/** A trivial in-memory audit store, the shape the browser localStorage store satisfies. */
function memoryStore() {
    let entries = [];
    return {
        load: () => entries,
        save: (next) => {
            entries = next;
        },
        _raw: () => entries,
    };
}

/** Build the Node-side custom warehouse descriptor over a fresh municipal db. */
function nodeWarehouse() {
    return loadCustomWarehouse({
        env: { [CUSTOM_ENV.db]: freshMunicipalDb(), [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST },
    });
}

/** Build the browser engine over a fresh in-memory WASM database. */
async function browserEngine(store = memoryStore()) {
    const SQL = await initSqlJs({ locateFile: (f) => join(SQLJS_DIST, f) });
    const sqlite = sqljsAdapter(new SQL.Database());
    const engine = createDemoEngine({ sqlite, seedSql: SEED_SQL, allowlist: ALLOWLIST_DOC, store });
    return { engine, store };
}

const CASES = [
    ['grant-status', {}],
    ['grant-status', { grant_id: 'G-402' }],
    ['grant-status', { grant_id: 'G-317' }],
    ['grant-status', { status: 'active' }],
    ['grant-status', { status: 'closed' }],
    ['spending-by-vendor', {}],
    ['spending-by-vendor', { grant_id: 'G-402' }],
    ['spending-by-vendor', { fiscal_year: 2026, dept_id: 'PW' }],
    ['budget-variance', {}],
    ['budget-variance', { fiscal_year: 2026 }],
    ['budget-variance', { fiscal_year: 2027, dept_id: 'PR' }],
];

test('browser engine matches the Node engine for every demo case', async () => {
    const node = nodeWarehouse();
    const { engine } = await browserEngine();

    for (const [name, args] of CASES) {
        const label = `${name} ${JSON.stringify(args)}`;
        const nodeOut = runNamedQuery(node, name, args, { guard });
        const webOut = engine.runNamed(name, args);

        assert.deepEqual(webOut.rows, nodeOut.rows, `rows differ for ${label}`);
        assert.deepEqual(webOut.checks, nodeOut.checks, `checks differ for ${label}`);
        assert.equal(webOut.integrity, nodeOut.integrity, `integrity differs for ${label}`);
        assert.equal(webOut.findings, nodeOut.findings, `findings differ for ${label}`);
        assert.equal(webOut.sql, nodeOut.lineage.sql, `executed SQL differs for ${label}`);
        assert.equal(
            webOut.provenance.resultHash,
            nodeOut.entry.resultHash,
            `result hash differs for ${label}`,
        );
        assert.match(webOut.provenance.resultHash, /^[0-9a-f]{64}$/);
    }
});

test('both engines reject a bad enum value and an unknown parameter identically', async () => {
    const node = nodeWarehouse();
    const { engine } = await browserEngine();

    for (const [name, args] of [
        ['grant-status', { status: 'frozen' }], // not in the enum
        ['grant-status', { nonsense: 1 }], // undeclared parameter
    ]) {
        let nodeErr;
        let webErr;
        try {
            runNamedQuery(node, name, args, { guard });
        } catch (e) {
            nodeErr = e;
        }
        try {
            engine.runNamed(name, args);
        } catch (e) {
            webErr = e;
        }
        assert.ok(nodeErr, 'Node should reject');
        assert.ok(webErr, 'browser should reject');
        assert.equal(webErr.message, nodeErr.message, `rejection message differs for ${name}`);
    }
});

test('the guard refuses a non-allow-listed table and column identically in-engine', async () => {
    // The browser bundles the same guard.js, so a query reaching outside the
    // municipal allow-list is refused with the same reason code the Node engine
    // gives. These SQLs would never come from a named query; they stand in for
    // the "try your own SQL" box.
    const node = nodeWarehouse();
    const options = guardOptionsFor(node);

    assert.throws(
        () => guard('SELECT * FROM payroll', options),
        (e) => e instanceof SqlRejected && e.reason === 'table_not_allowed',
    );
    assert.throws(
        () => guard('SELECT tax_id FROM vendors', options),
        (e) => e instanceof SqlRejected && e.reason === 'column_not_allowed',
    );
});

test('three runs build an intact chain; mutating an entry breaks it at its index', async () => {
    const { engine, store } = await browserEngine();

    engine.runNamed('grant-status', {});
    engine.runNamed('spending-by-vendor', {});
    engine.runNamed('budget-variance', {});

    const intact = engine.verifyChain();
    assert.equal(intact.ok, true);
    assert.equal(intact.entries, 3);

    // Mutate the middle entry directly in the store, as a tamperer would.
    const entries = store.load();
    entries[1] = { ...entries[1], findings: entries[1].findings + 99 };
    store.save(entries);

    const broken = engine.verifyChain();
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 1);

    // resetChain clears it back to a clean, empty, intact chain.
    engine.resetChain();
    const reset = engine.verifyChain();
    assert.equal(reset.ok, true);
    assert.equal(reset.entries, 0);
});

test('tamperFirstEntry corrupts entry 0 so verifyChain catches it', async () => {
    const { engine } = await browserEngine();
    assert.equal(engine.tamperFirstEntry(), false, 'nothing to tamper with on an empty chain');

    engine.runNamed('grant-status', { grant_id: 'G-402' });
    assert.equal(engine.verifyChain().ok, true);

    assert.equal(engine.tamperFirstEntry(), true);
    const broken = engine.verifyChain();
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 0);
});
