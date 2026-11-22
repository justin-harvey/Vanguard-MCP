/**
 * The S6 install surface: where the engine writes, the bundled municipal demo,
 * and that the bundled assets have not drifted from the skill's copy.
 * Offline: no network, no model, no SDK. Every write goes to a temp directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
    dataDir,
    dataPath,
    municipalDbPath,
    MUNICIPAL_SQL_PATH,
    MUNICIPAL_ALLOWLIST_PATH,
    INSURANCE_SQL_PATH,
    INSURANCE_ALLOWLIST_PATH,
} from '../src/paths.js';
import { buildMunicipalDemo, municipalAllowlistPath } from '../src/municipal.js';

const here = dirname(fileURLToPath(import.meta.url));
function freshDir() {
    return mkdtempSync(join(tmpdir(), 'cc-data-'));
}

test('CIVIC_DATA_DIR overrides every platform default', () => {
    const env = { CIVIC_DATA_DIR: '/custom/dir' };
    for (const platform of ['linux', 'darwin', 'win32']) {
        assert.equal(dataDir({ env, platform }), '/custom/dir');
    }
});

test('each platform resolves its conventional per-user data location', () => {
    const linux = dataDir({ env: { XDG_DATA_HOME: '/home/u/.local/share' }, platform: 'linux' });
    assert.equal(linux, join('/home/u/.local/share', 'civic-chain-auditor'));

    const darwin = dataDir({ env: {}, platform: 'darwin' });
    assert.ok(darwin.includes(join('Library', 'Application Support', 'civic-chain-auditor')));

    const win = dataDir({ env: { APPDATA: 'C:\\roaming' }, platform: 'win32' });
    assert.equal(win, join('C:\\roaming', 'civic-chain-auditor'));
});

test('dataPath only resolves, it does not create anything', () => {
    const dir = join(tmpdir(), 'cc-should-not-exist-' + process.pid);
    const p = dataPath('x.db', { env: { CIVIC_DATA_DIR: dir } });
    assert.equal(p, join(dir, 'x.db'));
    assert.equal(existsSync(dir), false);
});

test('buildMunicipalDemo builds the db and copies the allow-list into the data dir', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'municipal.db');
    const allowlistOut = join(dir, 'municipal-allowlist.json');
    const result = buildMunicipalDemo({ dbPath, allowlistOut });

    assert.equal(result.built, true);
    assert.equal(result.dbPath, dbPath);
    assert.equal(result.allowlistPath, allowlistOut);
    assert.ok(existsSync(dbPath));
    assert.ok(existsSync(allowlistOut));

    // The built database is a real, queryable ledger.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM expenditures').get();
        assert.ok(n > 0);
    } finally {
        db.close();
    }
});

test('buildMunicipalDemo is idempotent, and --rebuild forces a fresh build', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'municipal.db');
    const allowlistOut = join(dir, 'municipal-allowlist.json');

    assert.equal(buildMunicipalDemo({ dbPath, allowlistOut }).built, true);
    assert.equal(buildMunicipalDemo({ dbPath, allowlistOut }).built, false);
    assert.equal(buildMunicipalDemo({ dbPath, allowlistOut, rebuild: true }).built, true);
});

test('municipalDbPath / municipalAllowlistPath live under the data dir', () => {
    const env = { CIVIC_DATA_DIR: '/d' };
    assert.equal(municipalDbPath({ env }), join('/d', 'municipal.db'));
    assert.equal(municipalAllowlistPath({ env }), join('/d', 'municipal-allowlist.json'));
});

test('the bundled municipal assets match the skill copy byte for byte (one source of truth)', () => {
    const skillAssets = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'assets');
    assert.deepEqual(
        readFileSync(MUNICIPAL_SQL_PATH),
        readFileSync(join(skillAssets, 'sample_municipal_budget.sql')),
    );
    assert.deepEqual(
        readFileSync(MUNICIPAL_ALLOWLIST_PATH),
        readFileSync(join(skillAssets, 'sample_allowlist.json')),
    );
    // The S9 ruleset, its signature and the Civic-Chain public key ship in both
    // copies too; they must stay byte-identical or the signature check diverges.
    // The package nests municipal assets under assets/municipal/; the skill copy
    // is flat, so the ruleset lands directly in its assets/.
    const coreAssets = join(here, '..', 'assets');
    for (const [coreRel, skillRel] of [
        ['municipal/ruleset.municipal-v1.json', 'ruleset.municipal-v1.json'],
        ['municipal/ruleset.municipal-v1.json.sig', 'ruleset.municipal-v1.json.sig'],
        ['civic-chain-ruleset-pub.pem', 'civic-chain-ruleset-pub.pem'],
    ]) {
        assert.deepEqual(
            readFileSync(join(coreAssets, coreRel)),
            readFileSync(join(skillAssets, skillRel)),
            `${coreRel} drifted between the package and the skill copy`,
        );
    }
});

test('the bundled insurance assets match the skill copy byte for byte (one source of truth)', () => {
    const skillAssets = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'assets');
    assert.deepEqual(readFileSync(INSURANCE_SQL_PATH), readFileSync(join(skillAssets, 'sample_insurance_trust.sql')));
    assert.deepEqual(readFileSync(INSURANCE_ALLOWLIST_PATH), readFileSync(join(skillAssets, 'sample_insurance_allowlist.json')));
    // The signed ruleset and its detached signature must stay byte-identical in
    // both copies, or the signature check diverges between package and skill.
    const coreInsurance = join(here, '..', 'assets', 'insurance');
    for (const f of ['ruleset.insurance-v1.json', 'ruleset.insurance-v1.json.sig']) {
        assert.deepEqual(
            readFileSync(join(coreInsurance, f)),
            readFileSync(join(skillAssets, f)),
            `${f} drifted between the package and the skill copy`,
        );
    }
});
