// Tests for the relay. Offline by default: upstream fetch is stubbed so the
// suite never touches Sonos. Set LIVE=1 to add two real round-trips (one of
// them registers a throwaway OAuth client with Sonos -- do not run in CI).
import worker, { createRelay, clientKey } from "./src/index.js";
import config from "./src/config.js";

let pass = 0, fail = 0;
const chk = (name, cond, got) => { cond ? (pass++, console.log("  ok  ", name)) : (fail++, console.log("  FAIL", name, "->", got)); };
const req = (path, init = {}) => new Request("https://relay.test" + path, init);
const H = (o, extra = {}) => ({ origin: o, ...extra });
const OK = "https://trucs.ai";
const DEV = { ALLOW_LOCALHOST: "true" };

// --- stub upstream --------------------------------------------------------
const upstreamCalls = [];
const realFetch = globalThis.fetch;
let stubMode = null;
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), headers: init.headers, init });
  if (stubMode === "throw") throw new Error("dns");
  if (stubMode === "redirect") {
    return new Response(null, { status: 302, headers: { location: "https://evil.example/x", "set-cookie": "a=b", "content-security-policy": "x", "x-secret": "1" } });
  }
  if (new URL(url).pathname === "/mcp-oauth/register") {
    return new Response('{"client_id":"stub"}', { status: 201, headers: { "content-type": "application/json" } });
  }
  return new Response('{"error":"access_denied"}', {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="stub"', "mcp-session-id": "sess-1", "set-cookie": "s=1", "x-upstream": "1" },
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
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H("http://localhost.evil.com") }), DEV);
chk("localhost.evil.com -> 403", r.status === 403, r.status);
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H("https://trucs.ai.evil.com") }));
chk("trucs.ai.evil.com -> 403", r.status === 403, r.status);
for (const o of ["http://localhost:8000", "http://127.0.0.1:8000", "http://localhost"]) {
  r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(o) }), DEV);
  chk(`dev origin ${o} allowed with ALLOW_LOCALHOST`, r.status === 204 && r.headers.get("access-control-allow-origin") === o, r.status);
}

for (const o of ["http://localhost:8000", "http://127.0.0.1:8000"]) {
  r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(o) }));
  chk(`localhost ${o} refused by default`, r.status === 403, r.status);
  r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(o) }), { ALLOW_LOCALHOST: "false" });
  chk(`localhost ${o} refused when flag is false`, r.status === 403, r.status);
}
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H("http://[::1]:8000") }), DEV);
chk("[::1] not accepted", r.status === 403, r.status);

// --- preflight ------------------------------------------------------------
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(OK) }));
chk("preflight 204", r.status === 204, r.status);
chk("ACAO reflected, not *", r.headers.get("access-control-allow-origin") === OK, r.headers.get("access-control-allow-origin"));
chk("Vary: Origin", r.headers.get("vary") === "Origin", r.headers.get("vary"));
chk("no Allow-Credentials", r.headers.get("access-control-allow-credentials") === null, "set");
chk("allows mcp-session-id request header", r.headers.get("access-control-allow-headers").includes("mcp-session-id"), r.headers.get("access-control-allow-headers"));
chk("exposes mcp-session-id", r.headers.get("access-control-expose-headers").includes("mcp-session-id"), r.headers.get("access-control-expose-headers"));
chk("no PNA header unless asked", r.headers.get("access-control-allow-private-network") === null, "set");
chk("preflight allow-methods per path", r.headers.get("access-control-allow-methods") === "GET,POST,DELETE,OPTIONS", r.headers.get("access-control-allow-methods"));
chk("nosniff on preflight", r.headers.get("x-content-type-options") === "nosniff", "missing");
r = await worker.fetch(req("/mcp-oauth/token", { method: "OPTIONS", headers: H(OK) }));
chk("token preflight allows POST only", r.headers.get("access-control-allow-methods") === "POST,OPTIONS", r.headers.get("access-control-allow-methods"));
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

r = await worker.fetch(req("/mcp-oauth/register", { method: "POST", headers: H(OK, { "content-type": "application/json" }), body: '{"redirect_uris":["https://trucs.ai/sonos/"]}' }));
chk("register -> 201 through relay", r.status === 201 && (await r.json()).client_id === "stub", r.status);

r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK, { "content-length": String(10 * 1024 * 1024) }), body: "x" }));
chk("oversized body -> 413", r.status === 413, r.status);
chk("413 carries ACAO so the page can see it", r.headers.get("access-control-allow-origin") === OK, "missing");

// --- methods (F1) ---------------------------------------------------------
upstreamCalls.length = 0;
for (const [m, p] of [["PUT", "/mcp-oauth/register"], ["GET", "/mcp-oauth/token"], ["GET", "/mcp-oauth/register"], ["PATCH", "/mcp"], ["PUT", "/mcp"], ["DELETE", "/mcp-oauth/token"]]) {
  r = await worker.fetch(req(p, { method: m, headers: H(OK), body: ["GET"].includes(m) ? undefined : "{}" }));
  chk(`${m} ${p} -> 405`, r.status === 405 && r.headers.get("access-control-allow-origin") === OK, r.status);
}
chk("405s never reached upstream", upstreamCalls.length === 0, upstreamCalls.length);
for (const m of ["GET", "DELETE"]) {
  r = await worker.fetch(req("/mcp", { method: m, headers: H(OK) }));
  chk(`${m} /mcp allowed`, r.status === 401, r.status);
}

// --- body limit (F2) ------------------------------------------------------
const LIM = config.maxBodyBytes;
const chunked = (total, size = 8192) => {
  let sent = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(size, total - sent); sent += n; c.enqueue(new Uint8Array(n));
    },
    cancel() { cancelled = true; },
  });
  return { stream, sent: () => sent, cancelled: () => cancelled };
};
const post = body => worker.fetch(new Request("https://relay.test/mcp", { method: "POST", headers: H(OK), body, duplex: "half" }));
upstreamCalls.length = 0;
let c = chunked(LIM * 100);
r = await post(c.stream);
chk("chunked oversize body (no Content-Length) -> 413", r.status === 413 && r.headers.get("access-control-allow-origin") === OK, r.status);
chk("oversize stream cancelled early, not read to the end", c.sent() < LIM * 4, c.sent());
chk("oversize never reached upstream", upstreamCalls.length === 0, upstreamCalls.length);
c = chunked(LIM);
r = await post(c.stream);
chk("body of exactly 64 KB accepted", r.status === 401, r.status);
chk("64 KB body forwarded intact", upstreamCalls.at(-1)?.init.body.byteLength === LIM, upstreamCalls.at(-1)?.init.body?.byteLength);
r = await post(chunked(LIM + 1).stream);
chk("64 KB + 1 -> 413", r.status === 413, r.status);
r = await post(new Uint8Array(LIM + 1));
chk("64 KB + 1 with Content-Length -> 413", r.status === 413, r.status);

// --- upstream failure (F6) ------------------------------------------------
stubMode = "throw";
r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK), body: "{}" }));
chk("upstream throws -> 502", r.status === 502, r.status);
chk("502 carries ACAO", r.headers.get("access-control-allow-origin") === OK, "missing");

// --- redirects (F5) and response header filtering -------------------------
stubMode = "redirect";
upstreamCalls.length = 0;
r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK), body: "{}" }));
chk("fetch uses redirect: manual", upstreamCalls[0].init.redirect === "manual", upstreamCalls[0].init.redirect);
chk("3xx returned as is, not followed", r.status === 302, r.status);
chk("Location not forwarded", r.headers.get("location") === null, r.headers.get("location"));
chk("Set-Cookie not forwarded", r.headers.get("set-cookie") === null, r.headers.get("set-cookie"));
chk("CSP and unknown headers not forwarded", r.headers.get("content-security-policy") === null && r.headers.get("x-secret") === null, "leaked");
stubMode = null;
r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK), body: "{}" }));
chk("upstream Set-Cookie / x-upstream dropped", r.headers.get("set-cookie") === null && r.headers.get("x-upstream") === null, "leaked");
chk("nosniff on responses", r.headers.get("x-content-type-options") === "nosniff", "missing");

// --- DCR redirect_uris (F8) -----------------------------------------------
const reg = (body, env) => worker.fetch(req("/mcp-oauth/register", { method: "POST", headers: H(OK), body }), env);
upstreamCalls.length = 0;
for (const [name, body] of [
  ["foreign redirect_uri", '{"redirect_uris":["https://evil.com/cb"]}'],
  ["one foreign among good", '{"redirect_uris":["https://trucs.ai/sonos/","https://evil.com/cb"]}'],
  ["look-alike host", '{"redirect_uris":["https://trucs.ai.evil.com/"]}'],
  ["localhost without flag", '{"redirect_uris":["http://localhost:8000/"]}'],
  ["missing redirect_uris", "{}"],
  ["empty redirect_uris", '{"redirect_uris":[]}'],
  ["redirect_uris not an array", '{"redirect_uris":"https://trucs.ai/"}'],
  ["not a URL", '{"redirect_uris":["nope"]}'],
  ["not JSON", "nope"],
]) {
  r = await reg(body);
  chk(`register refuses: ${name}`, r.status === 400 && r.headers.get("access-control-allow-origin") === OK, r.status);
}
chk("refused registrations never reached upstream", upstreamCalls.length === 0, upstreamCalls.length);
r = await reg('{"redirect_uris":["http://localhost:8000/"]}', DEV);
chk("register localhost redirect with flag", r.status === 201, r.status);
r = await reg('{"redirect_uris":["http://localhost:8000/"]}', { ALLOW_LOCALHOST: "false" });
chk("register localhost redirect, flag false", r.status === 400, r.status);

// --- generic config (reuse for another MCP server) ------------------------
const other = createRelay({
  upstream: "https://mcp.example.test", routes: { "/rpc": ["POST"] }, registerPath: null,
  allowedOrigins: ["https://app.example"], requestHeaders: ["authorization"], responseHeaders: ["content-type", "x-thing"], maxBodyBytes: 10,
});
upstreamCalls.length = 0;
r = await other.fetch(req("/rpc", { method: "POST", headers: { origin: "https://app.example", authorization: "B", cookie: "c" }, body: "{}" }));
chk("custom config: upstream and route", upstreamCalls[0]?.url === "https://mcp.example.test/rpc", upstreamCalls[0]?.url);
chk("custom config: request headers from config", upstreamCalls[0].headers.get("authorization") === "B" && upstreamCalls[0].headers.get("cookie") === null, "?");
chk("custom config: exposed headers from config", r.headers.get("access-control-expose-headers") === "x-thing", r.headers.get("access-control-expose-headers"));
r = await other.fetch(req("/mcp", { method: "POST", headers: { origin: "https://app.example" } }));
chk("custom config: Sonos path 404", r.status === 404, r.status);
r = await other.fetch(req("/rpc", { method: "POST", headers: H(OK) }));
chk("custom config: trucs.ai not allowed", r.status === 403, r.status);
r = await other.fetch(req("/rpc", { method: "POST", headers: { origin: "https://app.example" }, body: "x".repeat(11) }));
chk("custom config: own body limit", r.status === 413, r.status);
r = await other.fetch(req("/constructor", { method: "POST", headers: { origin: "https://app.example" } }));
chk("prototype property names are not routes", r.status === 404, r.status);

// --- rate limiting (bindings from wrangler.toml; absent under dev-server) --
const limiter = ok => ({ limit: async () => ({ success: ok }) });
r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK) }), { RELAY_LIMIT: limiter(false), REGISTER_LIMIT: limiter(true) });
chk("over limit -> 429", r.status === 429, r.status);
chk("429 carries ACAO and Retry-After", r.headers.get("access-control-allow-origin") === OK && r.headers.get("retry-after") === "60", "missing");
r = await worker.fetch(req("/mcp-oauth/register", { method: "POST", headers: H(OK), body: "{}" }), { RELAY_LIMIT: limiter(true), REGISTER_LIMIT: limiter(false) });
chk("register has its own limiter", r.status === 429, r.status);
r = await worker.fetch(req("/mcp", { method: "OPTIONS", headers: H(OK) }), { RELAY_LIMIT: limiter(false), REGISTER_LIMIT: limiter(true) });
chk("preflight is rate limited too", r.status === 429, r.status);
const keys = [];
const spy = { limit: async o => (keys.push(o.key), { success: true }) };
for (const ip of ["2001:db8:1:2:aaaa::1", "2001:db8:1:2:bbbb::2", "203.0.113.7", "2001:DB8::5", undefined]) {
  await worker.fetch(req("/mcp", { method: "POST", headers: H(OK, ip ? { "cf-connecting-ip": ip } : {}) }), { RELAY_LIMIT: spy });
}
chk("IPv6 keyed by /64", keys[0] === keys[1] && keys[0] === "2001:db8:1:2::/64", keys.slice(0, 2));
chk("IPv4 keyed as is", keys[2] === "203.0.113.7", keys[2]);
chk("compressed IPv6 expands", keys[3] === "2001:db8:0:0::/64", keys[3]);
chk("missing ip -> shared key", keys[4] === "unknown", keys[4]);
chk("clientKey ::1", clientKey("::1") === "0:0:0:0::/64", clientKey("::1"));
r = await worker.fetch(req("/mcp", { method: "POST", headers: H(OK) }));
chk("no bindings (local dev) -> no limiting", r.status === 401, r.status);

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
