// CORS relay for the Sonos MCP server. mcp.ws.sonos.com sends no CORS
// headers, so browsers can't call it directly. This adds the missing
// headers and nothing else.

const UPSTREAM = "https://mcp.ws.sonos.com";
const ALLOWED_PATHS = new Set(["/mcp", "/mcp-oauth/token", "/mcp-oauth/register"]);
const FORWARD_REQUEST_HEADERS = ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
const EXPOSED_RESPONSE_HEADERS = "mcp-session-id,www-authenticate";
// OAuth and MCP payloads are a few KB; anything larger is not a client of this page.
const MAX_BODY_BYTES = 64 * 1024;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "https://trucs.ai") return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Expose-Headers": EXPOSED_RESPONSE_HEADERS,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (!ALLOWED_PATHS.has(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    if (!isAllowedOrigin(origin)) {
      return new Response("forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      const headers = {
        ...corsHeaders(origin),
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version",
        "Access-Control-Max-Age": "86400",
      };
      // Running this relay on your own machine while the page is served from
      // https://trucs.ai is a public -> private request; Chrome needs the
      // local server to opt in explicitly.
      if (request.headers.get("access-control-request-private-network") === "true") {
        headers["Access-Control-Allow-Private-Network"] = "true";
      }
      return new Response(null, { status: 204, headers });
    }

    // Per-IP limits (wrangler.toml), so a script can't exhaust the request
    // quota or spam Sonos's registration endpoint through here. The bindings
    // don't exist under dev-server.mjs, which passes no env.
    const limiter = url.pathname === "/mcp-oauth/register" ? env?.REGISTER_LIMIT : env?.RELAY_LIMIT;
    if (limiter) {
      const { success } = await limiter.limit({ key: request.headers.get("cf-connecting-ip") || "unknown" });
      if (!success) {
        return new Response("too many requests", { status: 429, headers: { ...corsHeaders(origin), "Retry-After": "60" } });
      }
    }

    if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
      return new Response("payload too large", { status: 413, headers: corsHeaders(origin) });
    }

    // Count the bytes actually received; Content-Length can be absent or wrong.
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) {
        return new Response("payload too large", { status: 413, headers: corsHeaders(origin) });
      }
    }

    const upstreamHeaders = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) upstreamHeaders.set(name, value);
    }

    // Deliberately no logging here: bearer tokens transit this Worker.
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers: upstreamHeaders,
      body,
    });

    const responseHeaders = new Headers(corsHeaders(origin));
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    const sessionId = upstream.headers.get("mcp-session-id");
    if (sessionId) responseHeaders.set("mcp-session-id", sessionId);
    const wwwAuth = upstream.headers.get("www-authenticate");
    if (wwwAuth) responseHeaders.set("www-authenticate", wwwAuth);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};
