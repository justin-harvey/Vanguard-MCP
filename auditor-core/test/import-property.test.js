/**
 * M4 (property): a broker's or property manager's own trust-account exports import
 * into the canonical property schema and run the four property-trust-v1 controls
 * with clean integrity, the same way the municipal importer does for an
 * expenditure export.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/sunsetkey_*.csv) are a fictional brokerage's trust
 * ledger, bank snapshots and leases in a realistic export shape (messy headers,
 * $/comma money, MM/DD/YYYY dates, blank lease / move-out / returned cells). They
 * mirror the clean demo seed, so all four controls read pass: the reconciled bank
 * balance covers the trust liability, no owner ledger is overdrawn, every active
 * lease's deposit is held in full, and the one ended lease's deposit was returned
 * inside the window.
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
    coerceLedgerType,
    coerceEntryType,
    coerceLeaseStatus,
    CANONICAL_PROPERTY_LEDGER_FIELDS,
    CANONICAL_PROPERTY_SNAPSHOT_FIELDS,
    CANONICAL_PROPERTY_LEASE_FIELDS,
    ImportError,
} from '../src/import-property.js';
import { runPropertyImport } from '../src/import-property-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');
const LEDGER = 'sunsetkey_trust_ledger.csv';
const BANK = 'sunsetkey_bank_snapshots.csv';
const LEASES = 'sunsetkey_leases.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-property-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** Both companion mappings, proposed from their fixtures. */
function companionMappings() {
    return {
        bankSnapshots: { file: BANK, mapping: mappingFor(BANK, CANONICAL_PROPERTY_SNAPSHOT_FIELDS).mapping },
        leases: { file: LEASES, mapping: mappingFor(LEASES, CANONICAL_PROPERTY_LEASE_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('ledger/entry/lease enums coerce and reject nonsense', () => {
    assert.equal(coerceLedgerType('owner'), 'OWNER');
    assert.equal(coerceLedgerType(' Deposit '), 'DEPOSIT');
    assert.throws(() => coerceLedgerType('tenant'), ImportError);
    assert.equal(coerceEntryType('in'), 'IN');
    assert.equal(coerceEntryType('OUT'), 'OUT');
    assert.throws(() => coerceEntryType('credit'), ImportError);
    assert.equal(coerceLeaseStatus('active'), 'ACTIVE');
    assert.equal(coerceLeaseStatus('Ended'), 'ENDED');
    assert.throws(() => coerceLeaseStatus('expired'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all three property files', () => {
    assert.deepEqual(mappingFor(LEDGER, CANONICAL_PROPERTY_LEDGER_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BANK, CANONICAL_PROPERTY_SNAPSHOT_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(LEASES, CANONICAL_PROPERTY_LEASE_FIELDS).missingRequired, []);

    const led = mappingFor(LEDGER, CANONICAL_PROPERTY_LEDGER_FIELDS).mapping;
    assert.equal(led.ledger_id, 'Ledger');
    assert.equal(led.ledger_type, 'Ledger Type');
    assert.equal(led.entry_type, 'Direction');
    assert.equal(led.amount_cents, 'Amount');
    assert.equal(led.entry_date, 'Entry Date');
    assert.equal(led.lease_id, 'Lease');
    // The ledger export carries no entry-id column; it is generated in file order.
    assert.ok(!('entry_id' in led));

    // The bank export carries no deposits-in-transit column; it defaults to 0.
    assert.ok(!('deposits_in_transit_cents' in mappingFor(BANK, CANONICAL_PROPERTY_SNAPSHOT_FIELDS).mapping));
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runPropertyImport({ file: LEDGER, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'property');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the four controls with clean integrity ────────

test('a real property export imports and all four controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(LEDGER, CANONICAL_PROPERTY_LEDGER_FIELDS).mapping;
    const result = await runPropertyImport({ file: LEDGER, mapping, ...companionMappings(), env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'property');
    assert.deepEqual(result.counts, { rowCount: 8, ledgers: 5, liabilityCents: 320000 });
    assert.equal(result.bankSnapshots.counts.snapshots, 2);
    assert.equal(result.leases.counts.leases, 3);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, LEDGER))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all four, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of ['trust-vs-liability', 'negative-owner-balances', 'deposits-held-vs-owed', 'deposit-return-overdue']) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
        assert.equal(byName[name].findings, 0, `${name} findings`);
    }

    // The audit chain is intact: import + two companions + four queries = 7 entries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 7);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed property-trust ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'property-trust-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the property schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'property-canonical-v1');
});

// ── the numbers are exact, the trust reconciles, and no resident PII enters ────

test('money is exact, the trust reconciles, and no resident records exist', async () => {
    const e = env();
    const mapping = mappingFor(LEDGER, CANONICAL_PROPERTY_LEDGER_FIELDS).mapping;
    const result = await runPropertyImport({ file: LEDGER, mapping, ...companionMappings(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // The trust liability is the signed sum of every ledger entry.
        const liability = db.prepare(
            "SELECT COALESCE(SUM(CASE WHEN entry_type = 'IN' THEN amount_cents ELSE -amount_cents END), 0) AS n FROM trust_ledger",
        ).get();
        assert.equal(liability.n, 320000);

        // No OWNER ledger is overdrawn.
        const owner = db.prepare(`
            SELECT ledger_id, SUM(CASE WHEN entry_type = 'IN' THEN amount_cents ELSE -amount_cents END) AS bal
            FROM trust_ledger WHERE ledger_type = 'OWNER' GROUP BY ledger_id ORDER BY ledger_id`).all()
            .map((r) => ({ ledger_id: r.ledger_id, bal: r.bal }));
        assert.deepEqual(owner, [
            { ledger_id: 'OWNER-100', bal: 50000 },
            { ledger_id: 'OWNER-200', bal: 50000 },
        ]);

        // The reconciled bank balance from the latest snapshot covers the liability.
        const bank = db.prepare(
            'SELECT bank_statement_balance_cents + deposits_in_transit_cents - outstanding_checks_cents AS reconciled FROM trust_bank_snapshots ORDER BY snapshot_date DESC LIMIT 1',
        ).get();
        assert.equal(bank.reconciled, 320000);

        // Every active lease's deposit is held in full (held == owed).
        const held = db.prepare(`
            SELECT l.lease_id, l.security_deposit_cents AS owed,
                   COALESCE((SELECT SUM(CASE WHEN t.entry_type = 'IN' THEN t.amount_cents ELSE -t.amount_cents END)
                             FROM trust_ledger t WHERE t.lease_id = l.lease_id AND t.ledger_type = 'DEPOSIT'), 0) AS held
            FROM leases l WHERE l.status = 'ACTIVE' ORDER BY l.lease_id`).all()
            .map((r) => ({ lease_id: r.lease_id, owed: r.owed, held: r.held }));
        assert.deepEqual(held, [
            { lease_id: 'L-001', owed: 120000, held: 120000 },
            { lease_id: 'L-002', owed: 100000, held: 100000 },
        ]);

        // No resident-PII table exists in an imported ledger.
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['leases', 'trust_bank_snapshots', 'trust_ledger']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the three non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(Object.keys(allow.tables).sort(), ['leases', 'trust_bank_snapshots', 'trust_ledger']);
});

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a malformed ledger type aborts the import, naming the row', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-property-bad-')) });
    const bad = 'Ledger,Ledger Type,Property,Direction,Amount,Entry Date\nOWNER-1,trust,P-9,IN,"$1,000.00",06/01/2026\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = { ledger_id: 'Ledger', ledger_type: 'Ledger Type', property_id: 'Property', entry_type: 'Direction', amount_cents: 'Amount', entry_date: 'Entry Date' };
    await assert.rejects(
        () => runPropertyImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Ledger Type.*ledger type/.test(err.message),
    );
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-property-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=property proposes then imports the ledger + companions with a clean gate', async () => {
    await withImportEnv(async () => {
        const proposal = await callTool('propose_csv_mapping', {
            file: LEDGER,
            pack: 'property',
            companions: { bankSnapshots: { file: BANK }, leases: { file: LEASES } },
        });
        assert.equal(proposal.pack, 'property');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.amount_cents, 'Amount');
        assert.deepEqual(proposal.bankSnapshots.missingRequired, []);
        assert.deepEqual(proposal.leases.missingRequired, []);

        const out = await callTool('import_csv', {
            file: LEDGER,
            pack: 'property',
            mapping: proposal.mapping,
            companions: {
                bankSnapshots: { file: BANK, mapping: proposal.bankSnapshots.mapping },
                leases: { file: LEASES, mapping: proposal.leases.mapping },
            },
        });
        assert.equal(out.pack, 'property');
        assert.equal(out.counts.rowCount, 8);
        assert.equal(out.gate.ok, true);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
