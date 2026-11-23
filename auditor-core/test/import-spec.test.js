/**
 * Contract test for the config-driven import registry (import-spec.js + import-run.js).
 *
 * The M4 import flow is now one engine parameterised by a per-pack spec, so a new
 * pack's import is a spec entry (plus its schema/build fns) rather than a new
 * runner. This test locks the spec *contract*: every registered pack must be
 * structurally complete and point at a real signed ruleset, so a half-wired spec
 * cannot ship. It also pins the two shipped packs' public shape (pack ids,
 * companion result keys, gate queries) that callers and the MCP tools depend on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { IMPORT_SPECS, IMPORT_PACKS, getImportSpec } from '../src/import-spec.js';
import { loadRuleset } from '../src/ruleset.js';

test('the registry lists exactly the packs that support CSV import', () => {
    assert.deepEqual([...IMPORT_PACKS].sort(), ['iolta', 'municipal']);
});

test('getImportSpec resolves known packs and throws on an unknown one', () => {
    assert.equal(getImportSpec('municipal').pack, 'municipal');
    assert.equal(getImportSpec('iolta').pack, 'iolta');
    assert.throws(() => getImportSpec('nope'), /unknown import pack "nope"/);
});

// The contract every spec (shipped or future) must satisfy. If a 3rd pack is
// added to the registry, these assertions run against it automatically.
for (const pack of IMPORT_PACKS) {
    test(`spec "${pack}" is structurally complete and points at a real signed ruleset`, () => {
        const spec = IMPORT_SPECS[pack];
        assert.equal(spec.pack, pack);
        assert.equal(typeof spec.emitPackField, 'boolean');
        assert.equal(typeof spec.schemaVersion, 'string');
        assert.ok(spec.schemaVersion.length > 0, 'schemaVersion is non-empty');

        // The ruleset the import runs under exists, loads, and is signed.
        assert.ok(existsSync(spec.rulesetPath), `ruleset file exists: ${spec.rulesetPath}`);
        const ruleset = loadRuleset(spec.rulesetPath);
        assert.equal(ruleset.signature.status, 'signed', `${pack} ruleset is signed`);

        // The gate queries are real named queries this ruleset serves.
        assert.ok(Array.isArray(spec.gateQueries) && spec.gateQueries.length > 0, 'gateQueries is a non-empty array');
        const served = new Set(Object.keys(ruleset.queries));
        for (const q of spec.gateQueries) {
            assert.ok(served.has(q), `gate query "${q}" is served by the ${pack} ruleset`);
        }

        // Primary file spec: fields, a build fn, tables, and the wording fns.
        const p = spec.primary;
        assert.ok(Array.isArray(p.fields) && p.fields.length > 0, 'primary.fields non-empty');
        assert.equal(typeof p.build, 'function', 'primary.build is a function');
        assert.ok(Array.isArray(p.tables) && p.tables.length > 0, 'primary.tables non-empty');
        for (const fn of ['proposeTitle', 'importQuestion', 'headerNoun']) {
            assert.equal(typeof p[fn], 'function', `primary.${fn} is a function`);
        }
        // derived is optional but, if present, must be a function.
        if (p.derived != null) assert.equal(typeof p.derived, 'function', 'primary.derived is a function when present');

        // Companions: ordered, each self-describing (unique result key, its own
        // apply fn, confirm flag, audit kind/tables and the wording fns).
        assert.ok(Array.isArray(spec.companions), 'companions is an array');
        const resultKeys = new Set();
        for (const c of spec.companions) {
            assert.ok(c.resultKey && !resultKeys.has(c.resultKey), `companion resultKey "${c.resultKey}" is present and unique`);
            resultKeys.add(c.resultKey);
            assert.ok(Array.isArray(c.fields) && c.fields.length > 0, `${c.resultKey}.fields non-empty`);
            assert.equal(typeof c.apply, 'function', `${c.resultKey}.apply is a function`);
            assert.ok(Array.isArray(c.tables) && c.tables.length > 0, `${c.resultKey}.tables non-empty`);
            assert.ok(typeof c.mapFlag === 'string' && c.mapFlag.startsWith('--'), `${c.resultKey}.mapFlag is a flag`);
            assert.ok(typeof c.kind === 'string' && c.kind.length > 0, `${c.resultKey}.kind non-empty`);
            for (const fn of ['missingMapError', 'proposeTitle', 'question', 'rowCount', 'summaryLine']) {
                assert.equal(typeof c[fn], 'function', `${c.resultKey}.${fn} is a function`);
            }
        }
    });
}

test('municipal and iolta pin the companion result keys callers depend on', () => {
    assert.deepEqual(getImportSpec('municipal').companions.map((c) => c.resultKey), ['grantRegister', 'grantDrawdowns']);
    assert.deepEqual(getImportSpec('iolta').companions.map((c) => c.resultKey), ['bankSnapshots', 'feeInvoices']);
    // Byte-identical with the original municipal runner: no top-level `pack` key.
    assert.equal(getImportSpec('municipal').emitPackField, false);
    assert.equal(getImportSpec('iolta').emitPackField, true);
});
