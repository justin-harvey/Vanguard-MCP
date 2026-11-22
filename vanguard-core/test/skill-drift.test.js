/**
 * Drift guard: the shipped skill (SKILL.md, references/, examples/) must not
 * name a tool, control id, canonical/named query or refusal reason that the
 * engine does not actually serve. The skill text loads into an agent's context
 * verbatim, so a stale name there becomes an instruction to call something that
 * doesn't exist. This test fails if any documented name is not backed by code.
 *
 * Extraction is deliberately format-specific, so it is the documentation that
 * must stay disciplined, not the test that must guess:
 *   - control ids   PREFIX<digit>.<digit>-slug      (e.g. CC7.2-audit-chain-integrity)
 *   - query names   warehouse/slug                  (e.g. municipal/grant-status)
 *   - tools         verb-prefixed snake_case         (e.g. run_canonical)
 *   - reasons       the leading column of the table in references/refusals.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlCatalog } from '../src/controls.js';
import { listTools, canonicalNames } from '../src/mcp.js';
import { CUSTOM_ENV } from '../src/custom.js';
import { loadRuleset } from '../src/ruleset.js';
import { freshMunicipalDb, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const SKILL = join(here, '..', '..', 'skills', 'civic-chain-auditor');

/** Read a skill doc, with its name for error messages. */
function doc(rel) {
    return { rel, text: readFileSync(join(SKILL, rel), 'utf8') };
}

/** Every markdown file in the skill package, recursing into subfolders. */
function skillDocs() {
    const docs = [doc('SKILL.md'), doc('README.md')];
    const walk = (sub) => {
        for (const e of readdirSync(join(SKILL, sub), { withFileTypes: true })) {
            const rel = join(sub, e.name);
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.md')) docs.push(doc(rel));
        }
    };
    for (const sub of ['references', 'examples']) walk(sub);
    return docs;
}

/** All matches of a global regex's first capture group (or full match), deduped. */
function matches(text, re) {
    return [...new Set([...text.matchAll(re)].map((m) => m[1] ?? m[0]))];
}

/** The refusal reason codes the engine can actually emit, read from source. */
function validReasons() {
    const found = new Set();
    for (const file of ['guard.js', 'ask.js', 'mcp.js']) {
        const text = readFileSync(join(SRC, file), 'utf8');
        for (const m of text.matchAll(/new SqlRejected\(\s*'([a-z_]+)'/g)) found.add(m[1]);
        for (const m of text.matchAll(/reason:\s*'([a-z_]+)'/g)) found.add(m[1]);
    }
    return found;
}

test('the municipal demo configures so named queries are in scope', () => {
    // canonicalNames() includes named queries only when a custom warehouse is
    // configured; configure the shipped municipal demo for the checks below.
    process.env[CUSTOM_ENV.db] = freshMunicipalDb();
    process.env[CUSTOM_ENV.allowlist] = MUNICIPAL_ALLOWLIST;
    assert.ok(canonicalNames().includes('municipal/grant-status'));
});

test('every control id the skill names exists in the catalog', () => {
    const real = new Set(controlCatalog().map((c) => c.id));
    const re = /\b(?:CC|PI|C)\d+\.\d+-[a-z0-9-]+/g;
    for (const { rel, text } of skillDocs()) {
        for (const id of matches(text, re)) {
            assert.ok(real.has(id), `${rel} names control "${id}", which the catalog does not have`);
        }
    }
});

test('every canonical/named query the skill names is served', () => {
    // canonicalNames() reflects the env-configured custom warehouse (municipal,
    // from the test above). The insurance pack's queries ship in its signed
    // ruleset rather than a configured warehouse, so resolve them from the
    // ruleset directly: a skill reference to an insurance query must match a
    // query the shipped ruleset actually defines.
    // The insurance, IOLTA, excise, property, HOA and nonprofit packs' queries
    // ship in their signed rulesets, so resolve each pack's names from its
    // shipped ruleset directly.
    const packNames = (pack, version) =>
        Object.keys(loadRuleset(join(here, '..', 'assets', pack, `ruleset.${version}.json`)).queries).map((q) => `${pack}/${q}`);
    const real = new Set([
        ...canonicalNames(),
        ...packNames('insurance', 'insurance-v1'),
        ...packNames('iolta', 'iolta-v1'),
        ...packNames('excise', 'excise-v1'),
        ...packNames('property', 'property-trust-v1'),
        ...packNames('hoa', 'hoa-v1'),
        ...packNames('nonprofit', 'nonprofit-v1'),
        ...packNames('schools', 'schools-v1'),
        ...packNames('construction', 'construction-v1'),
    ]);
    const re = /\b(?:enron|markets|saas|municipal|insurance|iolta|excise|property|hoa|nonprofit|schools|construction)\/[a-z][a-z-]*/g;
    for (const { rel, text } of skillDocs()) {
        for (const name of matches(text, re)) {
            assert.ok(real.has(name), `${rel} names query "${name}", which run_canonical does not serve`);
        }
    }
});

test('every tool-shaped name the skill names is a real tool', () => {
    const real = new Set(listTools().map((t) => t.name));
    // Verb-prefixed snake_case is this engine's tool-naming convention.
    const re = /\b((?:run|list|verify|execute|import|record)_[a-z_]+)\b/g;
    for (const { rel, text } of skillDocs()) {
        for (const name of matches(text, re)) {
            assert.ok(real.has(name), `${rel} names tool "${name}", which listTools does not expose`);
        }
    }
});

test('every refusal reason the refusal table documents can actually be emitted', () => {
    const real = validReasons();
    const { text } = doc('references/refusals.md');
    // The table's header cell is literally `reason`; every other leading-column
    // cell is an actual reason code.
    const documented = matches(text, /^\|\s*`([a-z_]+)`/gm).filter((r) => r !== 'reason');
    assert.ok(documented.length >= 10, 'expected the refusal table to list the reason codes');
    for (const reason of documented) {
        assert.ok(real.has(reason), `refusals.md documents reason "${reason}", which no source emits`);
    }
});
