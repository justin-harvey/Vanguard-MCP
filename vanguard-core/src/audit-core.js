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

/**
 * Walk a chain of entries and report whether it is intact.
 *
 * Signature checking is optional and injected: a caller that cares (the Node
 * path, with a public key) passes `verifySignature`; the browser, which never
 * signs, omits it. The result shape is the same four fields either way, so an
 * unsigned chain verifies clean.
 *
 * @param {object[]} entries
 * @param {object} [options]
 * @param {((entry: object) => boolean)|null} [options.verifySignature] returns
 *   false if a signed entry's signature does not verify
 * @returns {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
export function verifyEntries(entries, { verifySignature = null } = {}) {
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

    return { ok: true, entries: entries.length, brokenAt: null, reason: null };
}

/**
 * Reduce an audit entry to the provenance a caller should carry alongside a
 * result. Pure, and the one definition of that shape, so the MCP server
 * (run_canonical) and the browser demo return provenance identically. An entry
 * written in the browser carries no signature, so those fields are null.
 *
 * @param {object} entry
 * @returns {{ resultHash: string, auditSeq: number, auditHash: string, signature: string|null, signingKeyId: string|null, complianceTags: string[] }}
 */
export function provenanceOf(entry) {
    return {
        resultHash: entry.resultHash,
        auditSeq: entry.seq,
        auditHash: entry.hash,
        signature: entry.signature ?? null,
        signingKeyId: entry.signingKeyId ?? null,
        complianceTags: entry.complianceTags ?? [],
    };
}
