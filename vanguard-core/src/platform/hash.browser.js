/**
 * The hash seam, browser side.
 *
 * The demo build (see scripts/build-demo.js) resolves `platform/hash.js` to
 * this file instead, so the engine's hashing runs on the dependency-free,
 * synchronous SHA-256 in `sha256.js` rather than `node:crypto`. The two must
 * agree exactly; test/sha256.test.js asserts it.
 */
export { sha256hex } from './sha256.js';
