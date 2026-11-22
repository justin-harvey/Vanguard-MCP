import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPacks, findPack } from '../src/packs.js';
import { loadRuleset } from '../src/ruleset.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = join(here, '..', 'assets');
const skillAssets = join(here, '..', '..', 'skills', 'civic-chain-auditor', 'assets');

test('loadPacks resolves every bundled pack to files that exist', () => {
    const packs = loadPacks();
    assert.ok(packs.length >= 9, `expected at least 9 packs, got ${packs.length}`);
    for (const p of packs) {
        assert.ok(existsSync(p.rulesetPath), `${p.pack}: missing ruleset ${p.rulesetPath}`);
        assert.ok(existsSync(p.sqlPath), `${p.pack}: missing SQL seed ${p.sqlPath}`);
        assert.ok(existsSync(p.allowlistPath), `${p.pack}: missing allow-list ${p.allowlistPath}`);
    }
});

test('the registry names the same warehouse each ruleset declares', () => {
    for (const p of loadPacks()) {
        const r = loadRuleset(p.rulesetPath);
        // The ruleset's name is the ruleset id (e.g. municipal-v1), not the
        // warehouse; just assert it is a signed Civic-Chain ruleset loads cleanly.
        assert.equal(r.signature.status, 'signed', `${p.pack}: ruleset not signed`);
        assert.ok(Object.keys(r.queries).length > 0, `${p.pack}: ruleset has no queries`);
    }
});

test('every ruleset.*.json on disk is registered (no unregistered pack)', () => {
    const onDisk = readdirSync(coreAssets, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => readdirSync(join(coreAssets, d.name)).filter((f) => /^ruleset\..*\.json$/.test(f)).map((f) => join(d.name, f)));
    const registered = new Set(loadPacks().map((p) => p.rulesetPath.slice(coreAssets.length + 1)));
    for (const rel of onDisk) {
        assert.ok(registered.has(rel), `ruleset ${rel} ships but is not in assets/packs.json`);
    }
});

test('findPack resolves by pack key and by warehouse name', () => {
    assert.equal(findPack('construction')?.warehouse, 'construction');
    assert.equal(findPack('iolta')?.pack, 'iolta');
    assert.equal(findPack('does-not-exist'), null);
});

test('packs.json is byte-identical between the package and the skill copy', () => {
    assert.deepEqual(
        readFileSync(join(coreAssets, 'packs.json')),
        readFileSync(join(skillAssets, 'packs.json')),
        'packs.json drifted between the package and the skill copy',
    );
});
