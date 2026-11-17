/**
 * The browser build hashes with the dependency-free SHA-256 in
 * platform/sha256.js instead of node:crypto. If the two ever disagree, every
 * result hash and audit hash the browser computes is wrong and the whole
 * tamper-evidence story is broken. This test is that contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256hex } from '../src/platform/sha256.js';

const nodeHash = (s) => createHash('sha256').update(s).digest('hex');

test('pure SHA-256 agrees with node:crypto across a range of inputs', () => {
    const cases = [
        '',
        'a',
        'abc',
        'The quick brown fox jumps over the lazy dog',
        '{"a":1,"b":[2,3],"c":null}',
        'x'.repeat(55), // one byte short of a block boundary
        'x'.repeat(56), // forces a second padding block
        'x'.repeat(64),
        'x'.repeat(1000),
        'café éèê', // Latin-1 accents, multi-byte in UTF-8
        'ネットワーク送信なし', // Japanese, 3-byte UTF-8
        '🔒 ledger 🧾', // astral-plane emoji, 4-byte UTF-8
        '240000000', // the largest cents value in the demo, as text
    ];
    for (const input of cases) {
        assert.equal(sha256hex(input), nodeHash(input), `mismatch for ${JSON.stringify(input)}`);
    }
});

test('known-answer vectors', () => {
    assert.equal(sha256hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
