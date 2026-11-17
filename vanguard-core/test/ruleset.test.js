/**
 * S9: rulesets as the product.
 *
 * The ruleset (queries + checks) is Civic-Chain's, separate from the buyer's
 * access policy (the allow-list). It carries a version, a content hash over its
 * exact bytes, and a detached Ed25519 signature. The engine reports, on every
 * result, whether the ruleset is the one Civic-Chain signed (signed), was edited
 * or signed by another key (modified), or carries no signature (unsigned). Every
 * audit entry records the ruleset's content hash and the data's hash, so the
 * same CSV and ruleset version on two machines produce identical hashes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    parseRuleset,
    rulesetContentHash,
    signRuleset,
    verifyRuleset,
    loadRuleset,
    RulesetInvalid,
    CIVIC_CHAIN_PUBKEY_PATH,
} from '../src/ruleset.js';
import { generateSigner, keyIdOf } from '../src/signing.js';
import { createPublicKey } from 'node:crypto';
import { loadCustomWarehouse, CUSTOM_ENV } from '../src/custom.js';
import { runNamedQuery } from '../src/named-run.js';
import { guard } from '../src/guard.js';
import { readLog } from '../src/audit.js';
import { freshMunicipalDb, MUNICIPAL_ALLOWLIST } from './municipal-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED = join(here, '..', 'assets', 'municipal', 'ruleset.municipal-v1.json');

const trustedKey = () => createPublicKey(readFileSync(CIVIC_CHAIN_PUBKEY_PATH, 'utf8'));

// ── parsing ─────────────────────────────────────────────────────────────────

test('parseRuleset accepts a well-formed ruleset and rejects a malformed one', () => {
    const doc = JSON.parse(readFileSync(BUNDLED, 'utf8'));
    const r = parseRuleset(doc);
    assert.equal(r.name, 'municipal');
    assert.equal(r.version, 'municipal-v1');
    assert.deepEqual(Object.keys(r.queries), ['grant-status', 'spending-by-vendor', 'budget-variance']);
    assert.throws(() => parseRuleset({ name: 'x', version: 'v1' }), RulesetInvalid); // no queries
    assert.throws(() => parseRuleset({ name: 'X', version: 'v1', queries: doc.queries }), RulesetInvalid); // bad name
});

// ── content hash + signature ──────────────────────────────────────────────────

test('the content hash is the SHA-256 of the exact bytes', () => {
    const bytes = readFileSync(BUNDLED);
    assert.match(rulesetContentHash(bytes), /^[0-9a-f]{64}$/);
    assert.equal(rulesetContentHash(bytes), rulesetContentHash(bytes.toString('utf8')));
});

test('a ruleset signed by the trusted key verifies as signed', () => {
    const signer = generateSigner();
    const bytes = readFileSync(BUNDLED);
    const sig = signRuleset(bytes, signer);
    const result = verifyRuleset(bytes, sig, signer.publicKey);
    assert.equal(result.status, 'signed');
    assert.equal(result.signedBy, signer.keyId);
});

test('editing one byte flips a signed ruleset to modified', () => {
    const signer = generateSigner();
    const bytes = readFileSync(BUNDLED);
    const sig = signRuleset(bytes, signer);
    // Flip a single byte of the content.
    const edited = Buffer.from(bytes);
    edited[edited.length - 2] ^= 0x01;
    const result = verifyRuleset(edited, sig, signer.publicKey);
    assert.equal(result.status, 'modified');
});

test('a signature from another key is modified, not signed', () => {
    const bytes = readFileSync(BUNDLED);
    const other = generateSigner();
    const sig = signRuleset(bytes, other);
    const trusted = generateSigner();
    assert.equal(verifyRuleset(bytes, sig, trusted.publicKey).status, 'modified');
});

test('no signature means unsigned', () => {
    const bytes = readFileSync(BUNDLED);
    assert.equal(verifyRuleset(bytes, null, generateSigner().publicKey).status, 'unsigned');
});

// ── the bundled ruleset ───────────────────────────────────────────────────────

test('the bundled municipal ruleset loads as signed by the shipped Civic-Chain key', () => {
    const r = loadRuleset(BUNDLED);
    assert.equal(r.signature.status, 'signed');
    assert.equal(r.signature.signedBy, keyIdOf(trustedKey()));
    assert.match(r.contentHash, /^[0-9a-f]{64}$/);
});

test('a tampered copy of the bundled ruleset loads as modified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ruleset-'));
    const path = join(dir, 'r.json');
    const doc = JSON.parse(readFileSync(BUNDLED, 'utf8'));
    doc.changelog.push('sneaky edit');
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    // Copy the real signature beside it, as an attacker who kept the old sig would.
    writeFileSync(`${path}.sig`, readFileSync(`${BUNDLED}.sig`));
    const r = loadRuleset(path);
    assert.equal(r.signature.status, 'modified');
});

// ── warehouse integration ─────────────────────────────────────────────────────

test('a configured ruleset overrides the allow-list queries and attaches its status', () => {
    const w = loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: freshMunicipalDb(),
            [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: BUNDLED,
            [CUSTOM_ENV.dataHash]: 'deadbeef',
        },
    });
    assert.equal(w.ruleset.version, 'municipal-v1');
    assert.equal(w.ruleset.status, 'signed');
    assert.equal(w.dataHash, 'deadbeef');
    assert.ok('grant-status' in w.queries);
});

test('every named-query result records rulesetHash, dataHash and the signature status', () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'cc-ruleset-log-')), 'audit.jsonl');
    const w = loadCustomWarehouse({
        env: {
            [CUSTOM_ENV.db]: freshMunicipalDb(),
            [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST,
            [CUSTOM_ENV.ruleset]: BUNDLED,
            [CUSTOM_ENV.dataHash]: 'abc123',
            [CUSTOM_ENV.log]: logPath,
        },
    });
    const out = runNamedQuery(w, 'grant-status', { grant_id: 'G-402' }, { guard });
    assert.equal(out.integrity, 'pass');
    const entry = readLog(logPath).at(-1);
    assert.equal(entry.rulesetHash, w.ruleset.contentHash);
    assert.equal(entry.dataHash, 'abc123');
    assert.equal(entry.ruleset.status, 'signed');
    assert.equal(entry.ruleset.version, 'municipal-v1');
});

test('the same ruleset version on two "machines" records the same rulesetHash and resultHash', () => {
    const run = () => {
        const logPath = join(mkdtempSync(join(tmpdir(), 'cc-ruleset-m-')), 'audit.jsonl');
        const w = loadCustomWarehouse({
            env: {
                [CUSTOM_ENV.db]: freshMunicipalDb(),
                [CUSTOM_ENV.allowlist]: MUNICIPAL_ALLOWLIST,
                [CUSTOM_ENV.ruleset]: BUNDLED,
                [CUSTOM_ENV.log]: logPath,
            },
        });
        return runNamedQuery(w, 'grant-status', { grant_id: 'G-402' }, { guard });
    };
    const a = run();
    const b = run();
    assert.equal(a.entry.rulesetHash, b.entry.rulesetHash);
    assert.equal(a.lineage.resultHash, b.lineage.resultHash);
});
