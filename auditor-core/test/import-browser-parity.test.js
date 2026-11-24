/**
 * The acceptance gate for the in-browser CSV import.
 *
 * The product claim is that a visitor who drops their own expenditure CSV on the
 * demo page runs the *same* import a buyer runs with the Node package, and gets
 * the *same* result hashes — while the file never leaves their machine. This
 * test imports one fixture CSV through both paths:
 *
 *   Node path    buildLedgerFromCsv -> node:sqlite ledger file -> runNamedQuery
 *   browser path proposeImport/buildImportEngine -> canonical seed SQL -> WASM
 *                SQLite (sql.js) -> engine.runNamed, pure-JS SHA-256
 *
 * and asserts rows, checks, integrity, findings, the executed SQL and the result
 * hash all agree. If this fails, the in-browser import has drifted from the Node
 * importer. The agent proposes the same mapping on both sides, so the mapping
 * itself is also exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import initSqlJs from 'sql.js';
import { guard } from '../src/guard.js';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { runNamedQuery } from '../src/named-run.js';
import { buildLedgerFromCsv } from '../src/import-csv.js';
import { proposeImport, buildImportEngine } from '../src/browser/import-engine.js';
import { MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';

const require = createRequire(import.meta.url);
const SQLJS_DIST = dirname(require.resolve('sql.js'));
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'riverton_expenditures.csv');

const CSV_TEXT = readFileSync(FIXTURE, 'utf8');
const ALLOWLIST_DOC = JSON.parse(readFileSync(MUNICIPAL_ALLOWLIST, 'utf8'));

/** A trivial in-memory audit store (the shape the browser localStorage store satisfies). */
function memoryStore() {
    let entries = [];
    return { load: () => entries, save: (next) => { entries = next; }, _raw: () => entries };
}

/**
 * Node side: import the fixture to a canonical ledger file under the confirmed
 * mapping, then load it as a custom warehouse pointed at the bundled municipal
 * allow-list (the same document the browser uses, so the queries are identical).
 */
function nodeWarehouse(mapping) {
    const dir = mkdtempSync(join(tmpdir(), 'cc-import-parity-'));
    const dbPath = join(dir, 'ledger.sqlite');
    buildLedgerFromCsv({ csvPath: FIXTURE, mapping, dbPath });
    return loadCustomWarehouse({
        env: { [CUSTOM_ENV.db]: dbPath, [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST },
    });
}

/** Browser side: import the same CSV text and mapping into an in-memory WASM ledger. */
async function browserEngine(mapping, store = memoryStore()) {
    const SQL = await initSqlJs({ locateFile: (f) => join(SQLJS_DIST, f) });
    const { engine } = buildImportEngine({
        makeDb: () => new SQL.Database(),
        csvText: CSV_TEXT,
        mapping,
        allowlist: ALLOWLIST_DOC,
        store,
    });
    return engine;
}

const CASES = [
    ['grant-status', {}],
    ['spending-by-vendor', {}],
    ['spending-by-vendor', { fiscal_year: 2026 }],
    ['budget-variance', {}],
    ['budget-variance', { fiscal_year: 2026 }],
];

test('the agent proposes the same mapping on both sides', () => {
    // proposeImport is the browser's mapping step; it reuses proposeMapping, so
    // this pins that the fixture's real-world headers map to the required fields.
    const proposal = proposeImport(CSV_TEXT);
    assert.equal(proposal.missingRequired.length, 0, 'all required fields should be mapped');
    for (const req of ['invoice_date', 'vendor_name', 'amount']) {
        assert.ok(proposal.mapping[req], `required field ${req} should be mapped`);
    }
});

test('in-browser import matches the Node import for every case', async () => {
    const { mapping } = proposeImport(CSV_TEXT);
    const node = nodeWarehouse(mapping);
    const engine = await browserEngine(mapping);

    for (const [name, args] of CASES) {
        const label = `${name} ${JSON.stringify(args)}`;
        const nodeOut = runNamedQuery(node, name, args, { guard });
        const webOut = engine.runNamed(name, args);

        assert.deepEqual(webOut.rows, nodeOut.rows, `rows differ for ${label}`);
        assert.deepEqual(webOut.checks, nodeOut.checks, `checks differ for ${label}`);
        assert.equal(webOut.integrity, nodeOut.integrity, `integrity differs for ${label}`);
        assert.equal(webOut.findings, nodeOut.findings, `findings differ for ${label}`);
        assert.equal(webOut.sql, nodeOut.lineage.sql, `executed SQL differs for ${label}`);
        assert.equal(webOut.provenance.resultHash, nodeOut.entry.resultHash, `result hash differs for ${label}`);
        assert.match(webOut.provenance.resultHash, /^[0-9a-f]{64}$/);
    }
});

test('the imported ledger counts the fixture rows', async () => {
    const { mapping } = proposeImport(CSV_TEXT);
    const SQL = await initSqlJs({ locateFile: (f) => join(SQLJS_DIST, f) });
    const { counts } = buildImportEngine({
        makeDb: () => new SQL.Database(),
        csvText: CSV_TEXT,
        mapping,
        allowlist: ALLOWLIST_DOC,
        store: memoryStore(),
    });
    assert.ok(counts.rowCount > 0, 'should import at least one expenditure');
    assert.ok(counts.vendors > 0, 'should derive vendors');
    assert.ok(counts.budgetLines > 0, 'should derive budget lines');
});

test('a bad mapping is refused in the browser the same way', async () => {
    // Mapping the amount column to a text header should abort coercion with an
    // ImportError, not silently produce a zero total.
    await assert.rejects(
        async () => {
            const SQL = await initSqlJs({ locateFile: (f) => join(SQLJS_DIST, f) });
            buildImportEngine({
                makeDb: () => new SQL.Database(),
                csvText: CSV_TEXT,
                mapping: { invoice_date: 'Payment Date', vendor_name: 'Vendor Name', amount: 'Vendor Name' },
                allowlist: ALLOWLIST_DOC,
                store: memoryStore(),
            });
        },
        /not a money amount|column "Vendor Name"/,
    );
});

test('three imported-ledger runs build an intact chain; a mutation breaks it', async () => {
    const { mapping } = proposeImport(CSV_TEXT);
    const store = memoryStore();
    const engine = await browserEngine(mapping, store);

    engine.runNamed('spending-by-vendor', {});
    engine.runNamed('budget-variance', {});
    engine.runNamed('budget-variance', { fiscal_year: 2026 });

    const intact = engine.verifyChain();
    assert.equal(intact.ok, true);
    assert.equal(intact.entries, 3);

    const entries = store.load();
    entries[1] = { ...entries[1], findings: (entries[1].findings ?? 0) + 99 };
    store.save(entries);

    const broken = engine.verifyChain();
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 1);
});
