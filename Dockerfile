# Civic-Chain Grant & Budget Auditor — hosted demo engine (S7).
#
# This image runs the engine's HTTP API (`cc-auditor serve`) over SYNTHETIC
# municipal demo data only. It is meant to run on infrastructure fully separate
# from any Civic-Chain production system; that isolation is the product's trust
# story. The browser never reaches this container directly — the Supabase edge
# proxy (supabase/functions/query) does, server-to-server, behind the bearer
# ENGINE_SERVICE_TOKEN set as a Fly secret.
#
# Build context is the repo root so we can copy both the engine and the
# municipal demo assets.
FROM node:22-slim

WORKDIR /app

# Engine dependencies first, for layer caching. Omit dev deps (the test runner is
# built into Node; nothing here needs devDependencies at runtime).
COPY vanguard-core/package.json vanguard-core/package-lock.json ./vanguard-core/
RUN cd vanguard-core && npm ci --omit=dev

# Engine source and the municipal demo assets (allow-list + SQL seed; the .sqlite
# is .gitignored and rebuilt below).
COPY vanguard-core ./vanguard-core
COPY skills/civic-chain-auditor ./skills/civic-chain-auditor

# Build the synthetic warehouses at image-build time so they are immutable and
# present on boot. node:sqlite only, no network:
#   - municipal: the Grant & Budget demo (run_canonical named queries)
#   - saas / enron / markets: so list_controls / run_control and the Enron
#     reporting-gap chain stay live too.
RUN rm -f /app/skills/civic-chain-auditor/assets/sample_municipal_budget.sqlite \
    && node -e "const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync('/app/skills/civic-chain-auditor/assets/sample_municipal_budget.sqlite');\
db.exec(fs.readFileSync('/app/skills/civic-chain-auditor/assets/sample_municipal_budget.sql','utf8'));\
db.close();console.log('built municipal demo warehouse');" \
    && node vanguard-core/bin/vanguard.js seed \
    && node vanguard-core/bin/vanguard.js enron seed \
    && node vanguard-core/bin/vanguard.js markets seed

# Point the engine at the municipal warehouse. The audit log lives on a mounted
# volume (/data) so the demo's tamper-evident chain persists across deploys.
ENV CIVIC_DB_PATH=/app/skills/civic-chain-auditor/assets/sample_municipal_budget.sqlite \
    CIVIC_ALLOWLIST_PATH=/app/skills/civic-chain-auditor/assets/sample_allowlist.json \
    CIVIC_AUDIT_LOG=/data/municipal-audit.jsonl \
    PORT=8787
# ENGINE_SERVICE_TOKEN is NOT baked in — set it as a Fly secret. `serve` refuses
# to start without it, which is the intended safety behaviour.

EXPOSE 8787

# /data is a mountpoint for the Fly volume; create it so the log path is writable
# even if no volume is attached (ephemeral fallback).
RUN mkdir -p /data

CMD ["node", "vanguard-core/bin/vanguard.js", "serve", "--port", "8787"]
