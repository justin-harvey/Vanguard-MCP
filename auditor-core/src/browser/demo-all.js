/**
 * The combined demo bundle for demo.html.
 *
 * demo.html runs three independent in-browser demos — the plain-English sandbox
 * (byod), the full municipal ledger (demo), and "import your own CSV" (import).
 * Each used to ship as its own bundle, which meant the SQLite parser and the
 * engine were downloaded three times on one page. Importing the three
 * controllers through this single entry lets esbuild share that code once, so
 * the page transfers roughly a third of the JavaScript.
 *
 * Each controller boots itself on load and is scoped to its own element ids, so
 * importing them together is safe and order-independent.
 */

import './demo-entry.js';
import './byod-entry.js';
import './import-entry.js';
