/**
 * RFC 9162 Merkle checkpoint tests (truncation hardening).
 *
 * The hash chain alone cannot detect the newest entries being dropped: a
 * truncated prefix is still a valid chain (audit.test.js documents this). These
 * tests pin the Merkle checkpoint that closes the gap: the tree hash commits to
 * the entry count, and a consistency proof shows one log is an append-only
 * extension of an earlier one. The headline case is the truncation attack —
 * verifyEntries passes on a re-chained truncation, but fails it against a
 * trusted checkpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    merkleTreeHash,
    checkpointOf,
    consistencyProof,
    verifyConsistency,
    verifyEntries,
    appendEntry,
} from '../src/audit-core.js';
import { sha256hex } from '../src/platform/hash.js';
import { append, verify, readLog, exportPackage, checkpointOf as checkpointOfLog } from '../src/audit.js';

/** Build an n-entry in-memory chain with trivial lineage records. */
function chain(n) {
    const entries = [];
    for (let i = 0; i < n; i++) entries.push(appendEntry(entries, { question: `q${i}`, rowCount: i }));
    return entries;
}

function freshLog() {
    return join(mkdtempSync(join(tmpdir(), 'vanguard-merkle-')), 'audit.jsonl');
}

function writeEntries(path, entries) {
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('the Merkle tree hash follows RFC 9162 structure for small trees', () => {
    assert.equal(merkleTreeHash([]), sha256hex(''));
    assert.equal(merkleTreeHash(['aa']), sha256hex('00aa'));
    // Two leaves: HASH(0x01 || leaf(aa) || leaf(bb)).
    assert.equal(merkleTreeHash(['aa', 'bb']), sha256hex(`01${sha256hex('00aa')}${sha256hex('00bb')}`));
    // Three leaves split at the largest power of two below 3, i.e. 2 then 1.
    const left = sha256hex(`01${sha256hex('00aa')}${sha256hex('00bb')}`);
    const right = sha256hex('00cc');
    assert.equal(merkleTreeHash(['aa', 'bb', 'cc']), sha256hex(`01${left}${right}`));
});

test('a checkpoint commits to the entry count and root, and both move when an entry is appended', () => {
    const four = chain(4);
    const cp4 = checkpointOf(four);
    assert.equal(cp4.treeSize, 4);
    assert.match(cp4.rootHash, /^[0-9a-f]{64}$/);

    const five = chain(5);
    const cp5 = checkpointOf(five);
    assert.equal(cp5.treeSize, 5);
    assert.notEqual(cp5.rootHash, cp4.rootHash);
});

test('a consistency proof verifies an append-only extension for every prefix size', () => {
    const full = chain(7);
    const cpFull = checkpointOf(full);
    for (let m = 1; m < full.length; m++) {
        const cpM = checkpointOf(full.slice(0, m));
        const proof = consistencyProof(m, full);
        assert.ok(
            verifyConsistency({ first: m, firstHash: cpM.rootHash, second: full.length, secondHash: cpFull.rootHash, proof }),
            `consistency from size ${m} to ${full.length} should verify`,
        );
    }
});

test('the truncation attack: a re-chained prefix verifies as a chain but fails against a trusted checkpoint', () => {
    const full = chain(5);
    const trusted = checkpointOf(full); // what an anchor would hold: {treeSize:5, root}

    const truncated = full.slice(0, 3); // drop the two newest; prefix is still valid

    // Plain chain verification cannot see the truncation.
    assert.equal(verifyEntries(truncated).ok, true);

    // Against the trusted checkpoint it is caught, named as dropped entries.
    const caught = verifyEntries(truncated, { checkpoint: trusted });
    assert.equal(caught.ok, false);
    assert.equal(caught.brokenAt, 3);
    assert.match(caught.reason, /dropped/);

    // And the direct consistency proof from the trusted size to the shorter log fails.
    const shortCp = checkpointOf(truncated);
    assert.equal(
        verifyConsistency({
            first: trusted.treeSize,
            firstHash: trusted.rootHash,
            second: shortCp.treeSize,
            secondHash: shortCp.rootHash,
            proof: consistencyProof(trusted.treeSize, truncated),
        }),
        false,
    );
});

test('altering an entry inside the trusted range fails the checkpoint consistency check', () => {
    const full = chain(5);
    const trusted = checkpointOf(full);

    // Keep the count but rewrite entry 1 and re-chain forward, as a tamperer who
    // also fixes the links would. The per-entry walk still passes.
    const tampered = chain(5);
    tampered[1] = { ...tampered[1], question: 'rewritten' };
    tampered[1].hash = appendEntry(tampered.slice(0, 1), { question: 'rewritten', rowCount: 1 }).hash;
    for (let i = 2; i < tampered.length; i++) {
        tampered[i] = { ...tampered[i], prevHash: tampered[i - 1].hash };
        tampered[i].hash = appendEntry(tampered.slice(0, i), tampered[i]).hash;
    }

    const res = verifyEntries(tampered, { checkpoint: trusted });
    assert.equal(res.ok, false);
    assert.match(res.reason, /append-only extension/);
});

test('exportPackage embeds a checkpoint, and verify() detects a later truncation against it', () => {
    const path = freshLog();
    append({ question: 'one', rowCount: 1 }, { path });
    append({ question: 'two', rowCount: 2 }, { path });
    append({ question: 'three', rowCount: 3 }, { path });

    const pkg = exportPackage(path);
    assert.equal(pkg.checkpoint.treeSize, 3);
    assert.equal(pkg.checkpoint.rootHash, checkpointOfLog(readLog(path)).rootHash);

    // A tamperer drops the newest entry on disk. Plain verify is clean; verify
    // against the exported checkpoint catches it.
    writeEntries(path, readLog(path).slice(0, 2));
    assert.equal(verify(path).ok, true);
    const caught = verify(path, { checkpoint: pkg.checkpoint });
    assert.equal(caught.ok, false);
    assert.match(caught.reason, /dropped/);
});
