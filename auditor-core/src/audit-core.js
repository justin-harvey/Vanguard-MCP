/**
 * The audit chain, pure.
 *
 * This is the hash-chaining logic with no storage and no `node:` imports, so it
 * runs unchanged in the browser. `audit.js` layers file I/O and signing on top
 * of it; the browser engine layers a `localStorage` store on top of it. Both
 * build byte-identical entries from the same `appendEntry`, so an entry written
 * by one and verified by the other agree.
 *
 * The chaining rule: each entry carries the hash of the entry before it, and
 * its own hash covers that link. Altering any past entry changes its hash,
 * which breaks the `prevHash` of every entry after it. `verifyEntries` walks
 * the chain and reports the first index where it breaks.
 */

import { sha256hex } from './platform/hash.js';
import { canonicalize } from './lineage.js';

/** Hash marking the start of a chain. */
export const GENESIS = '0'.repeat(64);

/**
 * Hash one entry, covering its link to the previous one.
 *
 * The entry's own `hash` is excluded (it does not yet exist when hashing), and
 * so are the signature fields: a signature is computed *over* the hash and
 * attached afterwards, so it cannot be part of what the hash covers without a
 * circular dependency. Excluding them also means an unsigned and a later-signed
 * copy of the same record share a hash, so signing never disturbs the chain.
 *
 * @param {object} entry entry without its own `hash` field
 * @returns {string}
 */
export function hashEntry(entry) {
    const { hash, signature, signingKeyId, ...rest } = entry;
    return sha256hex(canonicalize(rest));
}

/**
 * Build the next chain entry from the existing entries and a lineage record.
 * Pure: it neither reads nor writes storage and does not sign. The caller
 * persists the returned entry and, if it signs, attaches the signature after
 * (signatures sit outside the hash; see `hashEntry`).
 *
 * @param {object[]} entries the chain so far, in order
 * @param {object} lineage the record to append (lineage plus any extra fields)
 * @param {object} [options]
 * @param {string[]} [options.complianceTags]
 * @returns {object} the new entry, with `seq`, `prevHash`, `complianceTags` and `hash`
 */
export function appendEntry(entries, lineage, { complianceTags = [] } = {}) {
    const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : GENESIS;
    const entry = {
        seq: entries.length,
        prevHash,
        complianceTags,
        ...lineage,
    };
    entry.hash = hashEntry(entry);
    return entry;
}

// ── RFC 9162 Merkle checkpoint (truncation hardening) ───────────────────────
//
// The hash chain detects any edit to a past entry, but not the newest entries
// being dropped: a shorter chain is still a valid prefix (see audit.test.js,
// "truncating the newest entry is not a chain break"). A re-chained truncation
// is just as invisible. The remedy is a Merkle tree over the entries, following
// RFC 9162 (Certificate Transparency 2.0): a *checkpoint* commits to both the
// set of entries AND their count, and a consistency proof shows one log is a
// pure append-only extension of an earlier one. Anchor a checkpoint and a later
// "the log only ever had N entries" claim is refutable.
//
// RFC 9162 §2.1 hashes raw bytes with 0x00/0x01 domain-separation prefixes.
// Here the leaves and nodes are hex strings and the prefixes are the ASCII '00'
// and '01', so the whole computation goes through the one `sha256hex` seam that
// Node and the browser share (sha256.test.js pins their equivalence). The tree
// structure is RFC 9162's; the hashing substrate is this engine's. It is not
// wire-compatible with a CT log, which this never talks to.

/** RFC 9162 §2.1 leaf hash of one entry's chain hash: HASH(0x00 || d). */
function merkleLeafHash(entryHash) {
    return sha256hex(`00${entryHash}`);
}

/** RFC 9162 §2.1 interior node hash: HASH(0x01 || left || right). */
function merkleNodeHash(left, right) {
    return sha256hex(`01${left}${right}`);
}

/** The largest power of two strictly less than n (n > 1). */
function largestPowerOfTwoBelow(n) {
    let k = 1;
    while (k << 1 < n) k <<= 1;
    return k;
}

/**
 * RFC 9162 §2.1 Merkle Tree Hash of a list of leaf data (each a hex string).
 * The empty tree hashes to SHA-256 of the empty input.
 *
 * @param {string[]} leaves entry chain-hashes, in order
 * @returns {string} 64-char hex root hash
 */
export function merkleTreeHash(leaves) {
    if (leaves.length === 0) return sha256hex('');
    if (leaves.length === 1) return merkleLeafHash(leaves[0]);
    const k = largestPowerOfTwoBelow(leaves.length);
    return merkleNodeHash(merkleTreeHash(leaves.slice(0, k)), merkleTreeHash(leaves.slice(k)));
}

/**
 * A checkpoint over a chain: its tree size and Merkle root. This is the value
 * to publish/anchor; unlike the bare head hash it commits to the entry count,
 * so truncation changes it.
 *
 * @param {object[]} entries
 * @returns {{ treeSize: number, rootHash: string }}
 */
export function checkpointOf(entries) {
    return { treeSize: entries.length, rootHash: merkleTreeHash(entries.map((e) => e.hash)) };
}

/**
 * RFC 9162 §2.1.2 consistency proof that a log of size `first` is a prefix of
 * the current `entries` (size `second`). Returns the array of node hashes a
 * verifier needs. Defined for 0 < first < second; first == 0 or first ==
 * second needs no proof.
 *
 * @param {number} first the earlier (trusted) tree size
 * @param {object[]} entries the current entries, size >= first
 * @returns {string[]}
 */
export function consistencyProof(first, entries) {
    const leaves = entries.map((e) => e.hash);
    const subproof = (m, d, b) => {
        if (m === d.length) return b ? [] : [merkleTreeHash(d)];
        const k = largestPowerOfTwoBelow(d.length);
        if (m <= k) return [...subproof(m, d.slice(0, k), b), merkleTreeHash(d.slice(k))];
        return [...subproof(m - k, d.slice(k), false), merkleTreeHash(d.slice(0, k))];
    };
    if (first <= 0 || first >= leaves.length) return [];
    return subproof(first, leaves, true);
}

/**
 * RFC 9162 §2.1.4.2 verification that two tree heads are consistent: that the
 * size-`second` log is an append-only extension of the size-`first` log, with
 * no entry in the first `first` positions altered or removed.
 *
 * @param {object} args
 * @param {number} args.first
 * @param {string} args.firstHash
 * @param {number} args.second
 * @param {string} args.secondHash
 * @param {string[]} args.proof
 * @returns {boolean}
 */
export function verifyConsistency({ first, firstHash, second, secondHash, proof }) {
    if (first < 0 || second < 0 || first > second) return false;
    if (first === 0) return true; // an empty tree is consistent with any log
    if (first === second) return proof.length === 0 && firstHash === secondHash;

    // RFC 9162 §2.1.4.2. Prepend first_hash when `first` is an exact power of 2.
    const path = (first & (first - 1)) === 0 ? [firstHash, ...proof] : [...proof];
    if (path.length === 0) return false;

    let fn = first - 1;
    let sn = second - 1;
    while (fn & 1) { fn >>= 1; sn >>= 1; }

    let fr = path[0];
    let sr = path[0];
    for (let i = 1; i < path.length; i++) {
        const c = path[i];
        if (sn === 0) return false;
        if ((fn & 1) || fn === sn) {
            fr = merkleNodeHash(c, fr);
            sr = merkleNodeHash(c, sr);
            while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
        } else {
            sr = merkleNodeHash(sr, c);
        }
        fn >>= 1;
        sn >>= 1;
    }
    return fr === firstHash && sr === secondHash && sn === 0;
}

/**
 * Walk a chain of entries and report whether it is intact.
 *
 * Signature checking is optional and injected: a caller that cares (the Node
 * path, with a public key) passes `verifySignature`; the browser, which never
 * signs, omits it. The result shape is the same four fields either way, so an
 * unsigned chain verifies clean.
 *
 * A trusted `checkpoint` (a Merkle checkpoint taken earlier, e.g. read back
 * from an external anchor) turns on truncation detection: the current log must
 * be an append-only extension of it. A shorter log, or one whose first
 * `treeSize` entries no longer reproduce the trusted root, fails here even
 * though the bare chain of a truncated prefix verifies clean.
 *
 * @param {object[]} entries
 * @param {object} [options]
 * @param {((entry: object) => boolean)|null} [options.verifySignature] returns
 *   false if a signed entry's signature does not verify
 * @param {{ treeSize: number, rootHash: string }|null} [options.checkpoint]
 *   a previously-trusted checkpoint to prove the log has not been truncated
 * @returns {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
export function verifyEntries(entries, { verifySignature = null, checkpoint = null } = {}) {
    let expectedPrev = GENESIS;

    for (const [index, entry] of entries.entries()) {
        if (entry.prevHash !== expectedPrev) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry ${index} points at ${entry.prevHash.slice(0, 12)}… but the previous entry hashes to ${expectedPrev.slice(0, 12)}…`,
            };
        }
        if (hashEntry(entry) !== entry.hash) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry ${index} has been modified since it was written (recomputed hash does not match)`,
            };
        }
        if (entry.seq !== index) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry at position ${index} claims seq ${entry.seq}, an entry was removed or reordered`,
            };
        }
        if (verifySignature && entry.signature && !verifySignature(entry)) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: index,
                reason: `entry ${index} carries a signature that does not verify against the supplied key`,
            };
        }
        expectedPrev = entry.hash;
    }

    // A trusted checkpoint catches what the per-entry walk cannot: the newest
    // entries dropped (a valid shorter prefix) or a re-chained truncation.
    if (checkpoint) {
        if (checkpoint.treeSize > entries.length) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: entries.length,
                reason: `the log has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} but a trusted checkpoint commits to ${checkpoint.treeSize}: ${checkpoint.treeSize - entries.length} entr${checkpoint.treeSize - entries.length === 1 ? 'y was' : 'ies were'} dropped`,
            };
        }
        const now = checkpointOf(entries);
        const consistent = verifyConsistency({
            first: checkpoint.treeSize,
            firstHash: checkpoint.rootHash,
            second: now.treeSize,
            secondHash: now.rootHash,
            proof: consistencyProof(checkpoint.treeSize, entries),
        });
        if (!consistent) {
            return {
                ok: false,
                entries: entries.length,
                brokenAt: checkpoint.treeSize > 0 ? checkpoint.treeSize - 1 : 0,
                reason: 'the log is not an append-only extension of the trusted checkpoint (an earlier entry was altered or removed)',
            };
        }
    }

    return { ok: true, entries: entries.length, brokenAt: null, reason: null };
}

/**
 * Reduce an audit entry to the provenance a caller should carry alongside a
 * result. Pure, and the one definition of that shape, so the MCP server
 * (run_canonical) and the browser demo return provenance identically. An entry
 * written in the browser carries no signature, so those fields are null.
 *
 * @param {object} entry
 * @returns {{ resultHash: string, auditSeq: number, auditHash: string, signature: string|null, signingKeyId: string|null, complianceTags: string[], ruleset: object|null, rulesetHash: string|null, dataHash: string|null }}
 */
export function provenanceOf(entry) {
    return {
        resultHash: entry.resultHash,
        auditSeq: entry.seq,
        auditHash: entry.hash,
        signature: entry.signature ?? null,
        signingKeyId: entry.signingKeyId ?? null,
        complianceTags: entry.complianceTags ?? [],
        // S9: which ruleset produced this result (with its signature status) and
        // the data it ran against. Null on entries written before S9 or without
        // a ruleset configured.
        ruleset: entry.ruleset ?? null,
        rulesetHash: entry.rulesetHash ?? null,
        dataHash: entry.dataHash ?? null,
    };
}
