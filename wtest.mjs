import worker from "./src/index.js";
const H = (o) => ({ origin: o });
let pass = 0, fail = 0;
const chk = (name, cond, got) => { cond ? (pass++, console.log("  ok  ", name)) : (fail++, console.log("  FAIL", name, "->", got)); };

let r = await worker.fetch(new Request("https://w.dev/evil", { headers: H("https://trucs.ai") }));
chk("blocks unknown path", r.status === 404, r.status);

r = await worker.fetch(new Request("https://w.dev/?url=https://evil.com", { headers: H("https://trucs.ai") }));
chk("no target-from-request", r.status === 404, r.status);

r = await worker.fetch(new Request("https://w.dev/mcp", { method: "POST", headers: H("https://evil.com") }));
chk("blocks foreign origin", r.status === 403, r.status);

r = await worker.fetch(new Request("https://w.dev/mcp", { method: "POST" }));
chk("blocks missing origin", r.status === 403, r.status);

for (const o of ["http://localhost:8000", "http://127.0.0.1:8000"]) {
  r = await worker.fetch(new Request("https://w.dev/mcp", { method: "OPTIONS", headers: H(o) }));
  chk(`allows ${o}`, r.status === 204 && r.headers.get("access-control-allow-origin") === o, r.status);
}

r = await worker.fetch(new Request("https://w.dev/mcp", { method: "OPTIONS", headers: H("http://localhost.evil.com") }));
chk("rejects localhost.evil.com", r.status === 403, r.status);

r = await worker.fetch(new Request("https://w.dev/mcp", { method: "OPTIONS", headers: H("https://trucs.ai") }));
chk("preflight 204", r.status === 204, r.status);
chk("preflight ACAO reflected", r.headers.get("access-control-allow-origin") === "https://trucs.ai", r.headers.get("access-control-allow-origin"));
chk("preflight not wildcard", r.headers.get("access-control-allow-origin") !== "*", "*");
chk("preflight Vary: Origin", r.headers.get("vary") === "Origin", r.headers.get("vary"));
chk("preflight allows mcp-session-id hdr", (r.headers.get("access-control-allow-headers") || "").includes("mcp-session-id"), r.headers.get("access-control-allow-headers"));
chk("exposes mcp-session-id", (r.headers.get("access-control-expose-headers") || "").includes("mcp-session-id"), r.headers.get("access-control-expose-headers"));

r = await worker.fetch(new Request("https://w.dev/mcp", {
  method: "POST",
  headers: { origin: "https://trucs.ai", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer invalid" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
}));
chk("live upstream reached", r.status === 401, r.status);
chk("401 carries ACAO", r.headers.get("access-control-allow-origin") === "https://trucs.ai", r.headers.get("access-control-allow-origin"));
chk("body streams through", (await r.text()).length > 0, "empty");

r = await worker.fetch(new Request("https://w.dev/mcp-oauth/register", {
  method: "POST",
  headers: { origin: "https://trucs.ai", "content-type": "application/json" },
  body: JSON.stringify({ client_name: "worker test", redirect_uris: ["https://trucs.ai/sonos/"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], application_type: "web" }),
}));
const body = await r.json().catch(() => ({}));
chk("DCR proxied 201", r.status === 201, r.status);
chk("DCR returned client_id", !!body.client_id, JSON.stringify(body).slice(0, 120));
chk("DCR response has ACAO", r.headers.get("access-control-allow-origin") === "https://trucs.ai", r.headers.get("access-control-allow-origin"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
