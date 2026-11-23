/**
 * M4 (nonprofit): a nonprofit's own fund-accounting export imports into the
 * canonical nonprofit schema and runs the five nonprofit-v1 controls with clean
 * integrity, the same way the municipal, IOLTA and construction importers do for
 * their exports.
 *
 * Offline, and writes only to a temp data directory (CIVIC_DATA_DIR) and reads
 * only from the committed fixtures folder (CIVIC_IMPORT_DIR). The committed
 * fixtures (test/fixtures/merrymeeting_*.csv) are an anonymized, fictional
 * organization's ("Merrymeeting Bay Community Services") restricted-fund register
 * plus its five companion exports (expenses / general ledger, restriction
 * releases, balance-sheet account balances, net assets, and federal awards) in a
 * realistic fund-accounting shape. They mirror the clean demo seed, so all five
 * controls read pass: every restricted-fund expense is within its purpose and
 * window, no release exceeds its qualifying spending, the functional-expense grid
 * ties total expenses ($202,000.00) with no negative cell, liquid assets
 * ($250,000) cover restricted net assets ($200,000), and federal spending
 * ($600,000) is below the Single Audit trigger ($1,000,000).
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
    coerceFundRestriction,
    coerceNetAssetClass,
    coerceAccountType,
    coerceFiscalYear,
    CANONICAL_NONPROFIT_FUND_FIELDS,
    CANONICAL_NONPROFIT_EXPENSE_FIELDS,
    CANONICAL_NONPROFIT_RELEASE_FIELDS,
    CANONICAL_NONPROFIT_BALANCE_FIELDS,
    CANONICAL_NONPROFIT_NET_ASSET_FIELDS,
    CANONICAL_NONPROFIT_FEDERAL_FIELDS,
    ImportError,
} from '../src/import-nonprofit.js';
import { runNonprofitImport } from '../src/import-nonprofit-run.js';
import { parseCsv } from '../src/import-csv.js';
import { verify } from '../src/audit.js';
import { callTool } from '../src/mcp.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, 'fixtures');

const FUNDS = 'merrymeeting_funds.csv';
const EXPENSES = 'merrymeeting_expenses.csv';
const RELEASES = 'merrymeeting_releases.csv';
const BALANCES = 'merrymeeting_account_balances.csv';
const NET_ASSETS = 'merrymeeting_net_assets.csv';
const FEDERAL = 'merrymeeting_federal_awards.csv';

function env({ importDir = FIXTURE_DIR } = {}) {
    return { CIVIC_DATA_DIR: mkdtempSync(join(tmpdir(), 'cc-nonprofit-data-')), CIVIC_IMPORT_DIR: importDir };
}

/** Propose a mapping from a fixture's headers + rows. */
function mappingFor(file, specs) {
    const { headers, rows } = parseCsv(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    return proposeMapping(headers, rows, specs);
}

/** The five confirmed companion imports, each mapped from its fixture. */
function allCompanions() {
    return {
        expenses: { file: EXPENSES, mapping: mappingFor(EXPENSES, CANONICAL_NONPROFIT_EXPENSE_FIELDS).mapping },
        releases: { file: RELEASES, mapping: mappingFor(RELEASES, CANONICAL_NONPROFIT_RELEASE_FIELDS).mapping },
        accountBalances: { file: BALANCES, mapping: mappingFor(BALANCES, CANONICAL_NONPROFIT_BALANCE_FIELDS).mapping },
        netAssets: { file: NET_ASSETS, mapping: mappingFor(NET_ASSETS, CANONICAL_NONPROFIT_NET_ASSET_FIELDS).mapping },
        federalAwards: { file: FEDERAL, mapping: mappingFor(FEDERAL, CANONICAL_NONPROFIT_FEDERAL_FIELDS).mapping },
    };
}

// ── coercion units ──────────────────────────────────────────────────────────

test('fund restriction coerces to RESTRICTED / UNRESTRICTED', () => {
    assert.equal(coerceFundRestriction('Restricted'), 'RESTRICTED');
    assert.equal(coerceFundRestriction('with donor restrictions'), 'RESTRICTED');
    assert.equal(coerceFundRestriction('temporarily restricted'), 'RESTRICTED');
    assert.equal(coerceFundRestriction('Unrestricted'), 'UNRESTRICTED');
    assert.equal(coerceFundRestriction('without donor restrictions'), 'UNRESTRICTED');
    assert.equal(coerceFundRestriction('general'), 'UNRESTRICTED');
    assert.throws(() => coerceFundRestriction('board designated'), ImportError);
});

test('net-asset class coerces to the ASC 958 two classes', () => {
    assert.equal(coerceNetAssetClass('With Donor Restrictions'), 'WITH_DONOR_RESTRICTIONS');
    assert.equal(coerceNetAssetClass('restricted'), 'WITH_DONOR_RESTRICTIONS');
    assert.equal(coerceNetAssetClass('Without Donor Restrictions'), 'WITHOUT_DONOR_RESTRICTIONS');
    assert.equal(coerceNetAssetClass('unrestricted'), 'WITHOUT_DONOR_RESTRICTIONS');
    assert.throws(() => coerceNetAssetClass('board designated'), ImportError);
});

test('balance-sheet account types coerce to CASH / INVESTMENT / OTHER', () => {
    assert.equal(coerceAccountType('Cash'), 'CASH');
    assert.equal(coerceAccountType('cash and equivalents'), 'CASH');
    assert.equal(coerceAccountType('Investment'), 'INVESTMENT');
    assert.equal(coerceAccountType('endowment'), 'INVESTMENT');
    assert.equal(coerceAccountType('receivable'), 'OTHER');
    assert.throws(() => coerceAccountType('liability'), ImportError);
});

test('fiscal year coerces a 4-digit year, accepting an FY prefix', () => {
    assert.equal(coerceFiscalYear('2026'), 2026);
    assert.equal(coerceFiscalYear('FY2026'), 2026);
    assert.equal(coerceFiscalYear('FY 2026'), 2026);
    assert.throws(() => coerceFiscalYear(''), ImportError);
    assert.throws(() => coerceFiscalYear('26'), ImportError);
});

// ── mapping proposal ──────────────────────────────────────────────────────────

test('the proposer maps every required field of all six nonprofit files', () => {
    assert.deepEqual(mappingFor(FUNDS, CANONICAL_NONPROFIT_FUND_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(EXPENSES, CANONICAL_NONPROFIT_EXPENSE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(RELEASES, CANONICAL_NONPROFIT_RELEASE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(BALANCES, CANONICAL_NONPROFIT_BALANCE_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(NET_ASSETS, CANONICAL_NONPROFIT_NET_ASSET_FIELDS).missingRequired, []);
    assert.deepEqual(mappingFor(FEDERAL, CANONICAL_NONPROFIT_FEDERAL_FIELDS).missingRequired, []);
    const f = mappingFor(FUNDS, CANONICAL_NONPROFIT_FUND_FIELDS).mapping;
    assert.equal(f.fund_id, 'Fund Code');
    assert.equal(f.restriction_class, 'Restriction');
    assert.equal(f.purpose_code, 'Purpose');
    const fa = mappingFor(FEDERAL, CANONICAL_NONPROFIT_FEDERAL_FIELDS).mapping;
    assert.equal(fa.cfda_number, 'CFDA Number');
    assert.equal(fa.expended, 'Expended');
});

// ── propose stage writes nothing ──────────────────────────────────────────────

test('propose stage reads headers and writes nothing', async () => {
    const e = env();
    const r = await runNonprofitImport({ file: FUNDS, mapping: null, env: e });
    assert.equal(r.stage, 'propose');
    assert.equal(r.pack, 'nonprofit');
    assert.deepEqual(r.missingRequired, []);
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported')));
});

// ── the gate: a real import runs the five controls with clean integrity ────────

test('a real nonprofit export imports and all five controls pass integrity', async () => {
    const e = env();
    const mapping = mappingFor(FUNDS, CANONICAL_NONPROFIT_FUND_FIELDS).mapping;
    const result = await runNonprofitImport({ file: FUNDS, mapping, ...allCompanions(), env: e });

    assert.equal(result.stage, 'imported');
    assert.equal(result.pack, 'nonprofit');
    assert.deepEqual(result.counts, { rowCount: 3 });
    assert.equal(result.expenses.counts.expenses, 7);
    assert.equal(result.releases.counts.releases, 2);
    assert.equal(result.accountBalances.counts.balances, 3);
    assert.equal(result.netAssets.counts.netAssets, 2);
    assert.equal(result.federalAwards.counts.awards, 2);

    // The recorded source hash is the hash of the exact bytes imported.
    const expectHash = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, FUNDS))).digest('hex');
    assert.equal(result.sourceFileSha256, expectHash);

    // The gate: clean integrity on all five, no findings on clean books.
    assert.equal(result.gate.ok, true);
    const byName = Object.fromEntries(result.gate.queries.map((q) => [q.name, q]));
    for (const name of [
        'restricted-spending', 'releases-vs-spending', 'functional-expense-tie',
        'restricted-cash-coverage', 'single-audit-threshold',
    ]) {
        assert.equal(byName[name].integrity, 'pass', `${name} integrity`);
        assert.equal(byName[name].findings, 0, `${name} findings`);
    }

    // The audit chain is intact: import + five companions + five attested queries.
    const integrity = verify(result.paths.logPath);
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 11);
    assert.equal(result.audit.seq, 0);

    // The import runs under the signed nonprofit ruleset, tying data to ruleset.
    assert.equal(result.ruleset.version, 'nonprofit-v1');
    assert.equal(result.ruleset.status, 'signed');
    const importEntry = JSON.parse(readFileSync(result.paths.logPath, 'utf8').trim().split('\n')[0]);
    assert.equal(importEntry.dataHash, expectHash);
    assert.equal(importEntry.rulesetHash, result.ruleset.contentHash);

    // The confirmed mapping was persisted under the nonprofit schema version.
    assert.ok(existsSync(result.paths.mappingPath));
    assert.equal(JSON.parse(readFileSync(result.paths.mappingPath, 'utf8')).canonicalSchemaVersion, 'nonprofit-canonical-v1');
});

// ── the numbers are exact and no donor PII enters ──────────────────────────────

test('money is exact, coverage holds, and no donor-PII table exists', async () => {
    const e = env();
    const mapping = mappingFor(FUNDS, CANONICAL_NONPROFIT_FUND_FIELDS).mapping;
    const result = await runNonprofitImport({ file: FUNDS, mapping, ...allCompanions(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        // The functional-expense grid ties total expenses: $202,000.00.
        const total = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM expenses').get();
        assert.equal(total.t, 20_200_000);

        // Liquid assets (cash + investment) cover restricted net assets:
        // $250,000 liquid vs $200,000 with donor restrictions.
        const liquid = db.prepare("SELECT COALESCE(SUM(balance_cents), 0) AS t FROM account_balances WHERE account_type IN ('CASH', 'INVESTMENT')").get();
        const restrictedNa = db.prepare("SELECT balance_cents FROM net_assets WHERE restriction_class = 'WITH_DONOR_RESTRICTIONS'").get();
        assert.equal(liquid.t, 25_000_000);
        assert.equal(restrictedNa.balance_cents, 20_000_000);
        assert.ok(liquid.t >= restrictedNa.balance_cents);

        // Federal spending in FY2026 is below the Single Audit trigger: $600,000 < $1,000,000.
        const federal = db.prepare('SELECT COALESCE(SUM(expended_cents), 0) AS t FROM federal_awards WHERE fiscal_year = 2026').get();
        assert.equal(federal.t, 60_000_000);
        assert.ok(federal.t < 100_000_000);

        // No donor-PII table exists in an imported ledger: the import has no
        // column that could hold a donor name, address or gift history.
        const hasDonorPii = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='donor_pii'").get();
        assert.equal(hasDonorPii, undefined);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
        assert.deepEqual(tables, ['account_balances', 'expenses', 'federal_awards', 'funds', 'net_assets', 'restriction_releases']);
    } finally {
        db.close();
    }

    // The copied allow-list lists exactly the six non-PII tables.
    const allow = JSON.parse(readFileSync(result.paths.allowlistPath, 'utf8'));
    assert.deepEqual(
        Object.keys(allow.tables).sort(),
        ['account_balances', 'expenses', 'federal_awards', 'funds', 'net_assets', 'restriction_releases'],
    );
});

// ── an unrestricted fund needs no window ───────────────────────────────────────

test('an unrestricted fund with a blank window defaults to an open window', async () => {
    const e = env();
    const mapping = mappingFor(FUNDS, CANONICAL_NONPROFIT_FUND_FIELDS).mapping;
    const result = await runNonprofitImport({ file: FUNDS, mapping, ...allCompanions(), env: e });

    const db = new DatabaseSync(result.paths.dbPath, { readOnly: true });
    try {
        const gen = db.prepare("SELECT restriction_class, window_start, window_end FROM funds WHERE fund_id = 'FND-GEN'").get();
        assert.equal(gen.restriction_class, 'UNRESTRICTED');
        assert.equal(gen.window_start, '0001-01-01');
        assert.equal(gen.window_end, '9999-12-31');
    } finally {
        db.close();
    }
});

// ── malformed input aborts rather than corrupting the ledger ───────────────────

test('a bad fund restriction aborts the fund import, naming the row, writing nothing', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-nonprofit-bad-')) });
    const bad = 'Fund Code,Fund Name,Restriction,Purpose,Restricted From,Restricted Through\nFND-X,Mystery Fund,board designated,SCHOLARSHIP,,\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad.csv'), bad);
    const mapping = {
        fund_id: 'Fund Code', fund_name: 'Fund Name', restriction_class: 'Restriction',
        purpose_code: 'Purpose', window_start: 'Restricted From', window_end: 'Restricted Through',
    };
    await assert.rejects(
        () => runNonprofitImport({ file: 'bad.csv', mapping, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Restriction.*unrecognised fund restriction/.test(err.message),
    );
    assert.ok(!existsSync(join(e.CIVIC_DATA_DIR, 'imported', 'bad', 'ledger.db')));
});

test('a bad account type aborts the account-balances companion, leaving the ledger untouched', async () => {
    const e = env({ importDir: mkdtempSync(join(tmpdir(), 'cc-nonprofit-badbal-')) });
    // A clean fund register so the ledger builds, then a bad balances companion.
    writeFileSync(join(e.CIVIC_IMPORT_DIR, FUNDS), readFileSync(join(FIXTURE_DIR, FUNDS)));
    const badBal = 'Balance ID,Account Type,Balance,As Of\nAB-9,liability,"$10,000.00",2026-12-31\n';
    writeFileSync(join(e.CIVIC_IMPORT_DIR, 'bad_bal.csv'), badBal);
    const mapping = mappingFor(FUNDS, CANONICAL_NONPROFIT_FUND_FIELDS).mapping;
    const balMapping = { balance_id: 'Balance ID', account_type: 'Account Type', balance: 'Balance', as_of: 'As Of' };
    await assert.rejects(
        () => runNonprofitImport({ file: FUNDS, mapping, accountBalances: { file: 'bad_bal.csv', mapping: balMapping }, env: e }),
        (err) => err instanceof ImportError && /Row 2.*Account Type.*unrecognised account type/.test(err.message),
    );
    // The fund register built, but the aborted companion left account_balances empty.
    const dbPath = join(e.CIVIC_DATA_DIR, 'imported', 'merrymeeting-funds', 'ledger.db');
    assert.ok(existsSync(dbPath));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM funds').get().n, 3);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_balances').get().n, 0);
    } finally {
        db.close();
    }
});

// ── MCP surface ───────────────────────────────────────────────────────────────

async function withImportEnv(fn, { importDir = FIXTURE_DIR } = {}) {
    const saved = { imp: process.env.CIVIC_IMPORT_DIR, data: process.env.CIVIC_DATA_DIR };
    process.env.CIVIC_IMPORT_DIR = importDir;
    process.env.CIVIC_DATA_DIR = mkdtempSync(join(tmpdir(), 'cc-nonprofit-mcp-'));
    try {
        return await fn();
    } finally {
        for (const [k, v] of [['CIVIC_IMPORT_DIR', saved.imp], ['CIVIC_DATA_DIR', saved.data]]) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('over MCP: pack=nonprofit proposes then imports the fund register with a clean gate', async () => {
    await withImportEnv(async () => {
        const companionFiles = {
            expenses: { file: EXPENSES }, releases: { file: RELEASES }, accountBalances: { file: BALANCES },
            netAssets: { file: NET_ASSETS }, federalAwards: { file: FEDERAL },
        };
        const proposal = await callTool('propose_csv_mapping', { file: FUNDS, pack: 'nonprofit', companions: companionFiles });
        assert.equal(proposal.pack, 'nonprofit');
        assert.deepEqual(proposal.missingRequired, []);
        assert.equal(proposal.mapping.fund_id, 'Fund Code');
        for (const key of ['expenses', 'releases', 'accountBalances', 'netAssets', 'federalAwards']) {
            assert.deepEqual(proposal[key].missingRequired, [], `${key} maps cleanly`);
        }

        const companions = {};
        for (const key of Object.keys(companionFiles)) {
            companions[key] = { file: companionFiles[key].file, mapping: proposal[key].mapping };
        }
        const out = await callTool('import_csv', { file: FUNDS, pack: 'nonprofit', mapping: proposal.mapping, companions });
        assert.equal(out.pack, 'nonprofit');
        assert.equal(out.counts.rowCount, 3);
        assert.equal(out.gate.ok, true);
        assert.equal(out.gate.queries.length, 5);
        assert.match(out.sourceFileSha256, /^[0-9a-f]{64}$/);
        assert.ok(existsSync(out.dbPath));
    });
});
