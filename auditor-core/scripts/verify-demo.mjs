/**
 * Drive the built in-browser demo in a real headless Chromium: prove the engine
 * runs locally, the audit chain verifies and catches tampering, the guard
 * refuses out-of-bounds SQL, and — the privacy claim — no network request
 * leaves the page after its assets have loaded.
 *
 * Not part of `npm test` (it needs a browser); run manually from auditor-core:
 *   node scripts/verify-demo.mjs
 *
 * Playwright is not a dependency of this package. Point the script at any local
 * install whose bundled Chromium is downloaded, via PLAYWRIGHT_DIR, e.g.
 *   PLAYWRIGHT_DIR=/path/to/project/node_modules node scripts/verify-demo.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', '..', 'site');

// Resolve playwright from PLAYWRIGHT_DIR, else from a few likely local installs.
// Its bundled Chromium revision must already be downloaded.
const candidates = [
    process.env.PLAYWRIGHT_DIR && join(process.env.PLAYWRIGHT_DIR, 'playwright'),
    'playwright',
].filter(Boolean);
let chromium;
for (const base of candidates) {
    try {
        const require = createRequire(base.startsWith('/') ? `${base}/` : import.meta.url);
        const pw = await import(require.resolve('playwright'));
        chromium = pw.chromium ?? pw.default?.chromium;
        if (chromium) break;
    } catch {
        // try the next candidate
    }
}
if (!chromium) {
    console.error('Could not load playwright. Set PLAYWRIGHT_DIR to a node_modules that has it.');
    process.exit(2);
}

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.woff2': 'font/woff2',
};

// The exact CSP netlify.toml serves, so this verifies the demo works *under the
// policy*, not just in a permissive sandbox.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const server = createServer(async (req, res) => {
    try {
        const path = decodeURIComponent(req.url.split('?')[0]);
        const file = join(siteDir, path === '/' ? '/index.html' : path);
        const body = await readFile(file);
        res.writeHead(200, {
            'content-type': TYPES[extname(file)] || 'application/octet-stream',
            'content-security-policy': CSP,
        });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end('not found');
    }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();

const requests = [];
page.on('request', (r) => requests.push({ url: r.url(), time: Date.now() }));

// Any CSP violation surfaces as a console error ("Refused to …"); collect page
// errors and such console messages so the policy is verified, not assumed.
const consoleErrors = [];
page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
    await page.goto(`${base}/demo.html`, { waitUntil: 'networkidle' });
    // Engine ready when the run button is enabled and the live-note updated.
    await page.waitForFunction(() => {
        const btn = document.getElementById('run-btn');
        return btn && !btn.disabled;
    }, { timeout: 15000 });
    check('engine loads in the browser', true);

    const loadedAt = Date.now();
    const assetsBefore = requests.length;

    // Run the default query.
    await page.click('#run-btn');
    await page.waitForFunction(() => /[0-9a-f]{64}/.test(document.getElementById('result')?.textContent || ''), { timeout: 10000 });
    const hash = (await page.locator('#result .prov .row').first().innerText()).match(/[0-9a-f]{64}/)?.[0];
    check('query returns a real 64-hex result hash', Boolean(hash), hash);
    const hasSql = (await page.locator('#result pre.sql').count()) > 0;
    check('executed SQL is shown', hasSql);

    // Verify the chain: intact.
    await page.click('#verify-btn');
    await page.waitForFunction(() => /chain INTACT/.test(document.getElementById('verify-out')?.textContent || ''), { timeout: 5000 });
    check('audit chain verifies INTACT', true);

    // Tamper, then verify: broken.
    await page.click('#tamper-btn');
    await page.click('#verify-btn');
    await page.waitForFunction(() => /chain BROKEN/.test(document.getElementById('verify-out')?.textContent || ''), { timeout: 5000 });
    check('tampering is caught (chain BROKEN)', true);

    // Reset, then verify: intact, 0 entries.
    await page.click('#reset-btn');
    const verifyText = await page.locator('#verify-out').innerText();
    check('reset clears the chain', /chain INTACT/i.test(verifyText) && /0 entr/i.test(verifyText), verifyText.replace(/\s+/g, ' ').trim());

    // Guard refuses the payroll table through the try-your-own-SQL box.
    await page.fill('#trysql-input', 'SELECT * FROM payroll');
    await page.click('#trysql-btn');
    await page.waitForFunction(() => /refused/.test(document.getElementById('trysql-out')?.textContent || ''), { timeout: 5000 });
    const refusal = await page.locator('#trysql-out').innerText();
    check('guard refuses the payroll table', /refused/i.test(refusal) && /table_not_allowed/i.test(refusal), refusal.replace(/\s+/g, ' ').trim().slice(0, 80));

    // The privacy claim: nothing left the page after it loaded.
    const after = requests.filter((r) => r.time > loadedAt + 300);
    check('zero network requests after load', after.length === 0,
        after.length ? after.map((r) => r.url).join(', ') : `${assetsBefore} asset requests during load, none after`);

    check('no console errors or CSP violations under the policy', consoleErrors.length === 0,
        consoleErrors.join(' | ').slice(0, 160));

    // Re-run a query so the screenshot shows a populated result, and save it.
    await page.click('#run-btn');
    await page.waitForFunction(() => /[0-9a-f]{64}/.test(document.getElementById('result')?.textContent || ''), { timeout: 10000 });
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
} catch (e) {
    check('run completed without error', false, e.message);
} finally {
    await browser.close();
    server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
