// Tests for the relay. Offline by default: upstream fetch is stubbed so the
// suite never touches Sonos. Set LIVE=1 to add two real round-trips (one of
// them registers a throwaway OAuth client with Sonos -- do not run in CI).
import worker from "./src/index.js";

let pass = 0, fail = 0;
const chk = (name, cond, got) => { cond ? (pass++, console.log("  ok  ", name)) : (fail++, console.log("  FAIL", name, "->", got)); };
const req = (path, init = {}) => new Request("https://relay.test" + path, init);
const H = (o, extra = {}) => ({ origin: o, ...extra });
const OK = "https://trucs.ai";

// --- stub upstream --------------------------------------------------------
const upstreamCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), headers: init.headers });
  if (new URL(url).pathname === "/mcp-oauth/register") {
    return new Response('{"client_id":"stub"}', { status: 201, headers: { "content-type": "application/json" } });
  }
  return new Response('{"error":"access_denied"}', {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="stub"', "mcp-session-id": "sess-1" },
  });
};

// --- path allowlist -------------------------------------------------------
let r = await worker.fetch(req("/evil", { headers: H(OK) }));
chk("unknown path -> 404", r.status === 404, r.status);
r = await worker.fetch(req("/?url=https://evil.com", { headers: H(OK) }));
chk("no target-from-request", r.status === 404, r.status);
r = await worker.fetch(req("/mcp/../mcp-oauth/token", { method: "POST", headers: H(OK) }));
chk("dot segments normalised, still allowlisted only", r.status === 401 && upstreamCalls.at(-1).url.endsWith("/mcp-oauth/token"), r.status);

// --- origin allowlist -----------------------------------------------------
r = await worker.fetch(req("/mcp", { method: "POST", headers: H("https://evil.com") }));
chk("foreign origin -> 403", r.status === 403, r.status);
r = await worker.fetch(req("/mcp", { method: "POST" }));
chk("missing origin -> 403", r.status === 403, r.status);
r = await worker.fetch(req("/mcp", { method: "POST", headers: H("null") }));
chk("null origin -> 403", r.status === 403, r.status);
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H("http://localhost.evil.com") }));
chk("localhost.evil.com -> 403", r.status === 403, r.status);
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H("https://trucs.ai.evil.com") }));
chk("trucs.ai.evil.com -> 403", r.status === 403, r.status);
for (const o of ["http://localhost:8000", "http://127.0.0.1:8000", "http://localhost"]) {
  r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(o) }));
  chk(`dev origin ${o} allowed`, r.status === 204 && r.headers.get("access-control-allow-origin") === o, r.status);
}

// --- preflight ------------------------------------------------------------
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(OK) }));
chk("preflight 204", r.status === 204, r.status);
chk("ACAO reflected, not *", r.headers.get("access-control-allow-origin") === OK, r.headers.get("access-control-allow-origin"));
chk("Vary: Origin", r.headers.get("vary") === "Origin", r.headers.get("vary"));
chk("no Allow-Credentials", r.headers.get("access-control-allow-credentials") === null, "set");
chk("allows mcp-session-id request header", r.headers.get("access-control-allow-headers").includes("mcp-session-id"), r.headers.get("access-control-allow-headers"));
chk("exposes mcp-session-id", r.headers.get("access-control-expose-headers").includes("mcp-session-id"), r.headers.get("access-control-expose-headers"));
chk("no PNA header unless asked", r.headers.get("access-control-allow-private-network") === null, "set");
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(OK, { "access-control-request-private-network": "true" }) }));
chk("PNA opt-in when asked", r.headers.get("access-control-allow-private-network") === "true", r.headers.get("access-control-allow-private-network"));

// --- forwarding -----------------------------------------------------------
upstreamCalls.length = 0;
r = await worker.fetch(req("/mcp", {
  method: "POST",
  headers: H(OK, {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    authorization: "Bearer t0k", "mcp-session-id": "sess-0", "mcp-protocol-version": "2025-06-18",
    cookie: "secret=1", referer: "https://trucs.ai/sonos/", "x-evil": "1", host: "evil.com",
  }),
  body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
}));
const up = upstreamCalls[0];
chk("forwards to hardcoded upstream", up?.url === "https://mcp.ws.sonos.com/mcp", up?.url);
chk("forwards authorization", up.headers.get("authorization") === "Bearer t0k", up.headers.get("authorization"));
chk("forwards mcp-session-id", up.headers.get("mcp-session-id") === "sess-0", "?");
chk("drops cookie", up.headers.get("cookie") === null, up.headers.get("cookie"));
chk("drops referer", up.headers.get("referer") === null, up.headers.get("referer"));
chk("drops unknown headers", up.headers.get("x-evil") === null, up.headers.get("x-evil"));
chk("drops origin", up.headers.get("origin") === null, up.headers.get("origin"));
chk("upstream status preserved", r.status === 401, r.status);
chk("401 carries ACAO", r.headers.get("access-control-allow-origin") === OK, r.headers.get("access-control-allow-origin"));
chk("www-authenticate passed through", r.headers.get("www-authenticate")?.startsWith("Bearer"), r.headers.get("www-authenticate"));
chk("mcp-session-id passed through", r.headers.get("mcp-session-id") === "sess-1", r.headers.get("mcp-session-id"));
chk("body passed through", (await r.text()).includes("access_denied"), "empty");

r = await worker.fetch(req("/mcp-oauth/register", { method: "POST", headers: H(OK, { "content-type": "application/json" }), body: "{}" }));
chk("register -> 201 through relay", r.status === 201 && (await r.json()).client_id === "stub", r.status);

r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK, { "content-length": String(10 * 1024 * 1024) }), body: "x" }));
chk("oversized body -> 413", r.status === 413, r.status);
chk("413 carries ACAO so the page can see it", r.headers.get("access-control-allow-origin") === OK, "missing");

// --- live (opt-in) --------------------------------------------------------
if (process.env.LIVE) {
  globalThis.fetch = realFetch;
  console.log("\nLIVE: two real requests to mcp.ws.sonos.com");
  r = await worker.fetch(req("/mcp", {
    method: "POST",
    headers: H(OK, { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer invalid" }),
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  }));
  chk("live: unauthenticated /mcp -> 401 with ACAO", r.status === 401 && r.headers.get("access-control-allow-origin") === OK, r.status);
  r = await worker.fetch(req("/mcp-oauth/register", {
    method: "POST", headers: H(OK, { "content-type": "application/json" }),
    body: JSON.stringify({ client_name: "relay test (throwaway)", redirect_uris: ["https://trucs.ai/sonos/"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  }));
  chk("live: DCR -> 201 with client_id", r.status === 201 && !!(await r.json()).client_id, r.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
