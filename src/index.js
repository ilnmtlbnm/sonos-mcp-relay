// CORS relay for the Sonos MCP server. mcp.ws.sonos.com sends no CORS
// headers, so browsers can't call it directly. This adds the missing
// headers and nothing else.

const UPSTREAM = "https://mcp.ws.sonos.com";
const ALLOWED_PATHS = new Set(["/mcp", "/mcp-oauth/token", "/mcp-oauth/register"]);
const FORWARD_REQUEST_HEADERS = ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
const EXPOSED_RESPONSE_HEADERS = "mcp-session-id,www-authenticate";

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (!ALLOWED_PATHS.has(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    if (!isAllowedOrigin(origin)) {
      return new Response("forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version",
          "Access-Control-Max-Age": "86400",
        },
      });
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
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      duplex: "half",
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
