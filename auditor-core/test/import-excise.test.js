/**
 * M4 (excise): a brewer's own excise filings export imports into the canonical
 * excise schema and runs the five excise-v1 controls with clean integrity, the
 * same way the municipal importer does for an expenditure export.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/penobscot_*.csv) are a fictional brewery's taxable
 * removals, rate schedule, operations reports and excise returns in a realistic
 * export shape (messy headers, $/comma money, MM/DD/YYYY dates, and no period or
 * due-date columns so the derivation paths are exercised). They mirror the clean
 * demo seed, so all five controls read pass and the two periods' liability ties
 * to $1,400.00 and $1,750.00.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
    proposeMapping,
    coerceBarrels,
    normalizePeriod,
    dueDateForPeriod,
    CANONICAL_EXCISE_REMOVAL_FIELDS,
    CANONICAL_EXCISE_RATE_FIELDS,
    CANONICAL_EXCISE_OPERATIONS_FIELDS,
    CANONICAL_EXCISE_RETURN_FIELDS,
    ImportError,
} from '../src/import-excise.js';
import { runExciseImport } from '../src/import-excise-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const REMOVALS = 'penobscot_removals.csv';
const RATES = 'penobscot_rate_schedule.csv';
const OPERATIONS = 'penobscot_operations_reports.csv';
const RETURNS = 'penobscot_excise_returns.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-excise-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** All three companion mappings, proposed from their fixtures. */
function companionMappings() {
    return {
        rates: { file: RATES, mapping: mappingFor(RATES, CANONICAL_EXCISE_RATE_FIELDS).mapping },
        operationsReports: { file: OPERATIONS, mapping: mappingFor(OPERATIONS, CANONICAL_EXCISE_OPERATIONS_FIELDS).mapping },
        returns: { file: RETURNS, mapping: mappingFor(RETURNS, CANONICAL_EXCISE_RETURN_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('barrels coerce to whole numbers and reject fractions and junk', () => {
    assert.equal(coerceBarrels('400'), 400);
    assert.equal(coerceBarrels('1,200'), 1200);
    assert.equal(coerceBarrels('250 bbl'), 250);
    assert.equal(coerceBarrels('300 Barrels'), 300);
    assert.throws(() => coerceBarrels('12.5'), ImportError);
    assert.throws(() => coerceBarrels('lots'), ImportError);
    assert.throws(() => coerceBarrels(''), ImportError);
});

test('periods normalise to YYYY-MM from several shapes and reject nonsense', () => {
    assert.equal(normalizePeriod('2026-01'), '2026-01');
    assert.equal(normalizePeriod('2026/1'), '2026-01');
    assert.equal(normalizePeriod('01/2026'), '2026-01');
    assert.equal(normalizePeriod('2026-02-20'), '2026-02'); // full date → its month
    assert.throws(() => normalizePeriod('2026-13'), ImportError);
    assert.throws(() => normalizePeriod('January'), ImportError);
    assert.throws(() => normalizePeriod(''), ImportError);
});

test('the filing due date is the 15th of the month after the period, rolling the year', () => {
    assert.equal(dueDateForPeriod('2026-01'), '2026-02-15');
    assert.equal(dueDateForPeriod('2026-02'), '2026-03-15');
    assert.equal(dueDateForPeriod('2026-12'), '2027-01-15');
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all four excise files', () => {
    assert.deepEqual(mappingFor(REMOVALS, CANONICAL_EXCISE_REMOVAL_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(RATES, CANONICAL_EXCISE_RATE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(OPERATIONS, CANONICAL_EXCISE_OPERATIONS_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(RETURNS, CANONICAL_EXCISE_RETURN_FIELDS).missingRequired, []);

    const rem = mappingFor(REMOVALS, CANONICAL_EXCISE_REMOVAL_FIELDS).mapping;
    assert.equal(rem.removal_date, 'Date Removed');
    assert.equal(rem.barrels, 'Barrels');
    assert.equal(rem.product_class, 'Product');
    // The removals export carries no period column; it is derived from the date.
    assert.ok(!('period' in rem));

    const rate = mappingFor(RATES, CANONICAL_EXCISE_RATE_FIELDS).mapping;
    assert.equal(rate.rate_cents_per_barrel, 'Rate Per Barrel');
    assert.equal(rate.effective_date, 'Effective Date');
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runExciseImport({ file: REMOVALS, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'excise');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the five controls with clean integrity ────────

test('a real excise export imports and all five controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(REMOVALS, CANONICAL_EXCISE_REMOVAL_FIELDS).mapping;
    const companions = companionMappings();

    const result = await runExciseImport({ file: REMOVALS, mapping, ...companions, env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'excise');
    assert.deepEqual(result.counts, { rowCount: 4, periods: 2, barrels: 900 });
    assert.equal(result.rates.counts.rates, 2);
    assert.equal(result.operationsReports.counts.reports, 2);
    assert.equal(result.returns.counts.returns, 2);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, REMOVALS))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all five, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of [
        'liability-vs-remitted', 'inventory-rollforward', 'report-vs-return',
        'missing-or-late-filings', 'loss-variance',
    ]) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
        assert.equal(byName[name].findings, 0, `${name} findings`);
    }

    // The audit chain is intact: import + rates + operations + returns + five queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 9);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed excise ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'excise-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the excise schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'excise-canonical-v1');
});

// ── the numbers are exact, derivations hold, and no customer PII enters ────────

test('money and barrels are exact, period and due date derive, and liability ties', async () => {
    const e = env();
    const mapping = mappingFor(REMOVALS, CANONICAL_EXCISE_REMOVAL_FIELDS).mapping;
    const result = await runExciseImport({ file: REMOVALS, mapping, ...companionMappings(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // Taxable barrels per period, summed from the removals (the primary file).
        const perPeriod = db.prepare(
            'SELECT period, SUM(barrels) AS bbl FROM removals GROUP BY period ORDER BY period',
        ).all().map((r) => ({ period: r.period, bbl: r.bbl }));
        assert.deepEqual(perPeriod, [{ period: '2026-01', bbl: 400 }, { period: '2026-02', bbl: 500 }]);

        // The period was derived from the removal date (no period column in the file).
        const firstRemoval = db.prepare("SELECT period FROM removals WHERE removal_id = 'RM-0001'").get();
        assert.equal(firstRemoval.period, '2026-01');

        // Liability ties: barrels × the 2026 reduced rate (350 c) equals the tax paid.
        const liability = db.prepare(`
            SELECT r.period,
                   (SELECT SUM(barrels) FROM removals WHERE period = r.period) * 350 AS expected_cents,
                   r.tax_paid_cents
            FROM tax_returns r ORDER BY r.period`).all()
            .map((r) => ({ period: r.period, expected_cents: r.expected_cents, tax_paid_cents: r.tax_paid_cents }));
        assert.deepEqual(liability, [
            { period: '2026-01', expected_cents: 140000, tax_paid_cents: 140000 },
            { period: '2026-02', expected_cents: 175000, tax_paid_cents: 175000 },
        ]);

        // The due dates were derived (no due-date column) to the 15th of the next month.
        const due = db.prepare("SELECT due_date FROM operations_reports WHERE period = '2026-01'").get();
        assert.equal(due.due_date, '2026-02-15');
        const retDue = db.prepare("SELECT due_date FROM tax_returns WHERE period = '2026-02'").get();
        assert.equal(retDue.due_date, '2026-03-15');

        // The 2025 rate row is preserved so the control proves effective-date selection.
        const rates = db.prepare('SELECT COUNT(*) AS n FROM tax_rates').get();
        assert.equal(rates.n, 2);

        // No customer-PII table exists in an imported ledger: the import has no
        // column that could hold a name, address or license number.
        const hasCustomers = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_accounts'").get();
        assert.equal(hasCustomers, undefined);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['operations_reports', 'removals', 'tax_rates', 'tax_returns']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the four non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(Object.keys(allow.tables).sort(), ['operations_reports', 'removals', 'tax_rates', 'tax_returns']);
});

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a non-integer barrels value aborts the import, naming the row', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-excise-bad-')) });
    const bad = 'Removal ID,Date Removed,Product,Barrels\nRM-1,02/10/2026,Beer,twelve\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = { removal_id: 'Removal ID', removal_date: 'Date Removed', product_class: 'Product', barrels: 'Barrels' };
    await assert.rejects(
        () => runExciseImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Barrels.*whole number of barrels/.test(err.message),
    );
    // Nothing partial was left behind.
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-excise-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=excise proposes then imports removals + companions with a clean gate', async () => {
    await withImportEnv(async () => {
        const proposal = await callTool('propose_csv_mapping', {
            file: REMOVALS,
            pack: 'excise',
            companions: { rates: { file: RATES }, operationsReports: { file: OPERATIONS }, returns: { file: RETURNS } },
        });
        assert.equal(proposal.pack, 'excise');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.barrels, 'Barrels');
        assert.deepEqual(proposal.rates.missingRequired, []);
        assert.deepEqual(proposal.operationsReports.missingRequired, []);
        assert.deepEqual(proposal.returns.missingRequired, []);

        const out = await callTool('import_csv', {
            file: REMOVALS,
            pack: 'excise',
            mapping: proposal.mapping,
            companions: {
                rates: { file: RATES, mapping: proposal.rates.mapping },
                operationsReports: { file: OPERATIONS, mapping: proposal.operationsReports.mapping },
                returns: { file: RETURNS, mapping: proposal.returns.mapping },
            },
        });
        assert.equal(out.pack, 'excise');
        assert.equal(out.counts.rowCount, 4);
        assert.equal(out.gate.ok, true);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
