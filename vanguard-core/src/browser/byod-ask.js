/**
 * The "ask in plain English" panel of the bring-your-own-expenditures demo.
 *
 * One question, one named query, one hashed answer, shown two ways from the
 * same result object:
 *   Dashboard  the answer card a finance user sees in the hosted product
 *   Agent      the same call as the civic-chain-auditor skill makes it from
 *              Claude (run_canonical), with the same result hash
 *
 * Dependencies are injected so byod-entry.js stays the only owner of parsing,
 * the engine and the detailed result renderer.
 */

import { interpret, answerFor, vocabularyOf, PlainEnglishRefusal, EXAMPLE_QUESTIONS } from './plain-english.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIEW_KEY = 'civic-chain-ask-view';

function argsLine(args) {
    const parts = Object.entries(args).map(([k, v]) => `<span class="ask-arg"><span class="k">${esc(k)}</span> = ${esc(JSON.stringify(v))}</span>`);
    return parts.length ? parts.join(' ') : '<span class="ask-arg muted">no parameters</span>';
}

function dashboardView(question, plan, out, answer) {
    const p = out.provenance || {};
    const intact = out.integrity === 'pass';
    return '<div class="ask-card">' +
        '<div class="ask-top"><span class="verdict ' + (intact ? 'ok' : 'flag') + '">' + (intact ? 'verified' : 'integrity flag') + '</span>' +
        '<span class="muted">' + esc(out.findings || 0) + ' finding' + ((out.findings || 0) === 1 ? '' : 's') + ' · ' + (out.rows || []).length + ' row' + ((out.rows || []).length === 1 ? '' : 's') + '</span></div>' +
        '<div class="ask-figure">' + esc(answer.figure) + '</div>' +
        '<p class="ask-sentence">' + esc(answer.text) + '</p>' +
        '<dl class="ask-meta">' +
        '<dt>Interpreted as</dt><dd><code>' + esc(plan.query) + '</code> ' + argsLine(plan.args) + '</dd>' +
        '<dt>Result hash</dt><dd><code class="hash">' + esc(p.resultHash || '—') + '</code></dd>' +
        '<dt>Audit entry</dt><dd><code>#' + esc(p.auditSeq) + ' · ' + esc(String(p.auditHash || '').slice(0, 24)) + '…</code> appended to this browser\'s chain</dd>' +
        '</dl></div>';
}

function agentView(question, plan, out, answer) {
    const p = out.provenance || {};
    const call = JSON.stringify({ name: 'sandbox/' + plan.query, args: plan.args }, null, 2);
    const result = JSON.stringify({ rows: (out.rows || []).length, integrity: out.integrity, findings: out.findings || 0, resultHash: p.resultHash, auditSeq: p.auditSeq }, null, 2);
    return '<div class="chat">' +
        '<div class="msg user"><span class="who">You</span><p>' + esc(question) + '</p></div>' +
        '<div class="tool"><span class="who">Tool call · civic-chain-auditor · run_canonical</span><pre>' + esc(call) + '</pre></div>' +
        '<div class="tool"><span class="who">Tool result</span><pre>' + esc(result) + '</pre></div>' +
        '<div class="msg agent"><span class="who">Claude</span><p>' + esc(answer.text) + '</p>' +
        '<p class="small">Result hash <code class="hash">' + esc(p.resultHash || '—') + '</code>. Anyone with the same rows can reproduce it with <code>verify_answer</code>.</p></div>' +
        '</div>' +
        '<p class="muted small">An illustration of the skill\'s output. In Claude, the model picks the named query; on this page a local phrase-matcher does. Everything after that step is the same engine, so the hash matches.</p>';
}

export function wireAsk({ buildEngine, readData, renderDetails, setStatus }) {
    const input = document.getElementById('ask-input');
    const form = document.getElementById('ask-form');
    const host = document.getElementById('ask-out');
    const details = document.getElementById('ask-details');
    const chips = document.getElementById('ask-chips');
    if (!input || !form || !host) return;

    let view = 'dashboard';
    try { view = window.localStorage.getItem(VIEW_KEY) || 'dashboard'; } catch { /* storage unavailable */ }
    let last = null;

    const paint = () => {
        if (!last) return;
        for (const b of document.querySelectorAll('[data-ask-view]')) {
            const on = b.getAttribute('data-ask-view') === view;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        document.getElementById('ask-views').hidden = false;
        host.innerHTML = view === 'agent' ? agentView(...last) : dashboardView(...last);
    };

    const ask = (question) => {
        input.value = question;
        let plan;
        try {
            const { expenditures, budgets } = readData();
            plan = interpret(question, vocabularyOf(expenditures, budgets));
        } catch (e) {
            last = null;
            document.getElementById('ask-views').hidden = true;
            if (details) details.hidden = true;
            const sugg = e instanceof PlainEnglishRefusal ? e.suggestions : [];
            host.innerHTML = '<div class="ask-card refused"><span class="verdict flag">refused</span><p class="ask-sentence">' + esc(e.message) + '</p>' +
                (sugg.length ? '<div class="ask-try">Try: ' + sugg.map((s) => '<button type="button" class="chip" data-ask-q="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>' : '') + '</div>';
            return;
        }
        try {
            const engine = buildEngine();
            const out = engine.runNamed(plan.query, plan.args);
            const answer = answerFor(plan.query, plan.args, out.rows || []);
            last = [question, plan, out, answer];
            renderDetails(out);
            if (details) details.hidden = false;
            setStatus('Answered through the guarded, read-only pipeline, locally.');
            paint();
        } catch (e) {
            last = null;
            document.getElementById('ask-views').hidden = true;
            host.innerHTML = '<div class="ask-card refused"><span class="verdict flag">refused</span><p class="ask-sentence">' + esc(e.message || String(e)) + '</p></div>';
        }
    };

    if (chips && !chips.children.length) {
        chips.innerHTML = EXAMPLE_QUESTIONS.map((s) => '<button type="button" class="chip" data-ask-q="' + esc(s) + '">' + esc(s) + '</button>').join('');
    }
    form.addEventListener('submit', (ev) => { ev.preventDefault(); ask(input.value); });
    document.addEventListener('click', (ev) => {
        const chip = ev.target.closest('[data-ask-q]');
        if (chip) { ask(chip.getAttribute('data-ask-q')); return; }
        const tab = ev.target.closest('[data-ask-view]');
        if (tab) {
            view = tab.getAttribute('data-ask-view');
            try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ }
            paint();
        }
    });
    return { ask };
}
