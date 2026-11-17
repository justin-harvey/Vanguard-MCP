/**
 * The audit log, append-only and tamper-evident.
 *
 * "Append-only" as a convention is worth very little: a file anyone can edit
 * is a file that can be quietly edited. What makes a log actually evidentiary
 * is that altering a past entry is *detectable*.
 *
 * Each entry therefore carries the hash of the entry before it, and its own
 * hash covers that link. Changing any historical record changes its hash,
 * which breaks the `prevHash` of the entry after it, and every entry after
 * that. `verify()` walks the chain and reports the first index where it
 * breaks. Deleting an entry from the middle breaks it in the same way.
 *
 * This is the same construction as the anchoring layer in TLaaS, minus the
 * on-chain step. It does not prevent tampering, nothing local can, it makes
 * tampering impossible to hide, which is what an auditor actually needs.
 *
 * Storage is JSON Lines: one entry per line, appended, never rewritten.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { signHash, verifyHash } from './signing.js';
import { GENESIS, hashEntry, appendEntry, verifyEntries } from './audit-core.js';
import { dataPath } from './paths.js';

// The audit log is runtime output; it lives in the writable per-user data
// directory (see paths.js), not inside the shipped package.
export const DEFAULT_LOG_PATH = dataPath('audit.jsonl');

// The chaining logic lives in audit-core.js so it can run in the browser with
// no node: imports. This module is the file-backed, optionally-signed wrapper
// around it. GENESIS and hashEntry are re-exported so existing importers of
// audit.js are unaffected.
export { GENESIS, hashEntry };

/**
 * Read every entry in the log.
 *
 * @param {string} [path]
 * @returns {object[]}
 */
export function readLog(path = DEFAULT_LOG_PATH) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
}

/**
 * Append one lineage record to the log, chained to what precedes it.
 *
 * @param {object} lineage
 * @param {object} [options]
 * @param {string} [options.path]
 * @param {string[]} [options.complianceTags]
 * @param {{ privateKey: import('node:crypto').KeyObject, keyId: string }|null} [options.signer]
 *   when supplied, the entry's hash is signed and the signature stored on it
 * @returns {object} the stored entry
 */
export function append(lineage, { path = DEFAULT_LOG_PATH, complianceTags = [], signer = null } = {}) {
    const existing = readLog(path);
    const entry = appendEntry(existing, lineage, { complianceTags });

    // The signature is computed over the hash and attached after it, so it sits
    // outside what the hash covers (see hashEntry).
    if (signer) {
        entry.signature = signHash(entry.hash, signer.privateKey);
        entry.signingKeyId = signer.keyId;
    }

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
}

/**
 * Walk the chain and report whether it is intact.
 *
 * When a `verifier` is supplied, any entry that carries a signature is checked
 * against it, so a forged or altered signature fails verification just as a
 * broken hash link does. Signature checking is contributory, not a shape
 * change: the result object is exactly the same four fields whether or not a
 * verifier is passed, so an unsigned log still verifies clean.
 *
 * @param {string} [path]
 * @param {object} [options]
 * @param {{ publicKey: import('node:crypto').KeyObject }|null} [options.verifier]
 * @returns {{ ok: boolean, entries: number, brokenAt: number|null, reason: string|null }}
 */
export function verify(path = DEFAULT_LOG_PATH, { verifier = null } = {}) {
    const entries = readLog(path);
    const verifySignature = verifier
        ? (entry) => verifyHash(entry.hash, entry.signature, verifier.publicKey)
        : null;
    return verifyEntries(entries, { verifySignature });
}

/**
 * The chain head, the hash of the most recent entry, or null for an empty
 * log. This is the value an external anchor should publish.
 *
 * @param {string} [path]
 * @returns {string|null}
 */
export function headHash(path = DEFAULT_LOG_PATH) {
    const entries = readLog(path);
    return entries.length > 0 ? entries[entries.length - 1].hash : null;
}

/**
 * Produce the exportable audit package.
 *
 * This is the "one click, not three weeks of email" artefact: the full chain,
 * its verification status at export time, and enough metadata for a reader to
 * re-run any query in it. A verifier checks signatures at export time; an
 * anchor receipt (computed by the caller, since anchoring may be async) is
 * embedded so the reader can confirm the head against an external record.
 *
 * @param {string} [path]
 * @param {object} [options]
 * @param {{ publicKey: import('node:crypto').KeyObject }|null} [options.verifier]
 * @param {object|null} [options.anchorReceipt]
 * @returns {object}
 */
export function exportPackage(path = DEFAULT_LOG_PATH, { verifier = null, anchorReceipt = null } = {}) {
    const entries = readLog(path);
    const integrity = verify(path, { verifier });

    const signedCount = entries.filter((entry) => entry.signature).length;

    return {
        generatedAt: new Date().toISOString(),
        entryCount: entries.length,
        integrity,
        // Stated explicitly so a reader does not have to infer it from the
        // absence of write operations.
        guarantees: {
            llmScope: 'sql_generation_only',
            databaseAccess: 'read_only_connection',
            everyFigureTraceable: true,
        },
        signing: {
            signedEntries: signedCount,
            allSigned: entries.length > 0 && signedCount === entries.length,
            verifiedAtExport: Boolean(verifier),
        },
        head: headHash(path),
        anchor: anchorReceipt,
        entries,
    };
}
