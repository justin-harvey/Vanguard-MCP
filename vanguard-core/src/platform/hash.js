/**
 * The hash seam, Node side.
 *
 * `lineage.js` and `audit-core.js` take SHA-256 from here rather than importing
 * `node:crypto` directly, so the browser build can swap this one small module
 * (see `hash.browser.js`) without touching anything that computes a hash. In
 * Node this is `node:crypto`: fast, standard, and no extra dependency for the
 * engine buyers run.
 *
 * @param {string} text UTF-8 text to hash
 * @returns {string} 64-character lowercase hex digest
 */
import { createHash } from 'node:crypto';

export function sha256hex(text) {
    return createHash('sha256').update(text).digest('hex');
}
