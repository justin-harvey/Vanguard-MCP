// Civic-Chain Grant & Budget Auditor, the secure proxy (Supabase Edge Function, Deno).
//
// The browser calls THIS; this calls the engine's HTTP API. The engine URL and
// its service token live only here (server-side), so no secret and no direct
// database reach ever ships to the client. The function does four things and
// nothing else: verify the caller's role, gate which tool that role may call,
// sanitise the arguments, and forward to the engine.
//
// The engine behind this proxy runs on infrastructure fully separate from any
// Civic-Chain production system and serves SYNTHETIC demo data only (the Town of
// Sampleton municipal warehouse). That isolation is the product's trust story.
//
// Role gating (enforced server-side):
//   - standard : the pre-approved control templates + canonical/named reads
//   - auditor  : the above, plus execute_financial_query (free-text custom SQL)
//
// Deploy:  supabase functions deploy query
// Secrets: supabase secrets set MCP_ENGINE_URL=... ENGINE_SERVICE_TOKEN=... ALLOWED_ORIGIN=https://<site>
// The Supabase gateway should verify the JWT (verify_jwt = true, the default),
// so reading the role claim below is trustworthy; anon callers fall back to the
// "standard" tier.

const ENGINE_URL = (Deno.env.get("MCP_ENGINE_URL") ?? "").replace(/\/$/, "");
const ENGINE_TOKEN = Deno.env.get("ENGINE_SERVICE_TOKEN") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

// The warehouse the hosted demo is about. Free-text and audit verification
// default here; a caller may name another built-in only from the allow-list
// below (so the Enron/SOC 2 pages can verify their own chains), never a path.
const DEMO_WAREHOUSE = "municipal";
const KNOWN_WAREHOUSES = new Set(["municipal", "saas", "enron", "markets", "lseg"]);

const ROLE_TOOLS: Record<string, Set<string>> = {
  standard: new Set(["list_controls", "run_control", "run_canonical", "verify_audit"]),
  auditor: new Set([
    "list_controls",
    "run_control",
    "run_canonical",
    "verify_audit",
    "execute_financial_query",
  ]),
};

// run_canonical's query arguments, whitelisted by name and coerced to a safe
// scalar. The municipal named queries take grant_id/status/fiscal_year/dept_id;
// the built-in market/forensics canonicals take ticker. Anything else a caller
// sends is dropped before it reaches the engine.
const CANONICAL_ARG_COERCE: Record<string, (v: unknown) => unknown> = {
  grant_id: String,
  status: String,
  dept_id: String,
  ticker: String,
  fiscal_year: (v) => Math.trunc(Number(v)),
};

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "content-type": "application/json",
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

// Read the role from the JWT's claims. The gateway has already verified the
// signature; a missing/anon token is the public "standard" tier.
function roleFromAuth(authHeader: string | null): string {
  if (!authHeader?.startsWith("Bearer ")) return "standard";
  try {
    const payload = JSON.parse(atob(authHeader.slice(7).split(".")[1]));
    return payload?.app_metadata?.role ?? payload?.role ?? "standard";
  } catch {
    return "standard";
  }
}

// Keep only the whitelisted, coerced canonical args; drop everything else.
function cleanCanonicalArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, coerce] of Object.entries(CANONICAL_ARG_COERCE)) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") {
      const value = coerce(raw[key]);
      if (typeof value !== "number" || Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

// Resolve a caller-named warehouse to a known built-in, or the demo default.
// A caller may pick which chain to verify, never a file path.
function resolveWarehouse(raw: unknown): string {
  const name = String(raw ?? "");
  return KNOWN_WAREHOUSES.has(name) ? name : DEMO_WAREHOUSE;
}

// Never forward raw client arguments to the engine, a caller must not be able
// to point a control at an arbitrary db/log path. Pass only the fields each tool
// legitimately takes.
function sanitize(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "run_control":
      return { id: String(args.id ?? "") };
    case "run_canonical": {
      const inner = (args.args ?? {}) as Record<string, unknown>;
      return {
        name: String(args.name ?? ""),
        args: cleanCanonicalArgs(typeof inner === "object" && inner ? inner : {}),
      };
    }
    case "verify_audit":
      // Verify the demo's own municipal chain by default; a caller may name
      // another known warehouse's chain, but never a path.
      return { warehouse: resolveWarehouse(args.warehouse) };
    case "execute_financial_query":
      return { question: String(args.question ?? ""), warehouse: DEMO_WAREHOUSE };
    default:
      return {};
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!ENGINE_URL) return json(500, { error: "engine_not_configured" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }

  const tool = String(body.tool ?? "");
  const rawArgs = (body.args ?? {}) as Record<string, unknown>;
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return json(400, { error: "bad_args" });

  const role = roleFromAuth(req.headers.get("authorization"));
  const allowed = ROLE_TOOLS[role] ?? ROLE_TOOLS.standard;
  if (!allowed.has(tool)) {
    return json(403, { error: "forbidden", role, tool, message: `role '${role}' may not call '${tool}'` });
  }

  try {
    const upstream = await fetch(`${ENGINE_URL}/tools/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ENGINE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(sanitize(tool, rawArgs)),
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: corsHeaders() });
  } catch (error) {
    return json(502, { error: "engine_unreachable", message: String((error as Error).message ?? error) });
  }
});
