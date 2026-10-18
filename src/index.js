// CORS relay for one fixed upstream MCP server (see config.js). The upstream
// sends no CORS headers, so browsers cannot call it directly. This adds the
// missing headers and nothing else.
import defaultConfig from "./config.js";

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Rate-limit key: IPv4 as is, IPv6 reduced to its /64 so one subscriber
// cannot mint endless keys.
export function clientKey(ip) {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // IPv4-mapped (::ffff:1.2.3.4) and similar: key on the embedded IPv4 address.
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  let groups = h;
  if (ip.includes("::")) {
    const t = tail ? tail.split(":") : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  }
  return groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

// Reads at most `limit` bytes; cancels the stream and returns null if exceeded.
async function readLimited(body, limit) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export function createRelay(config) {
  const exposed = config.responseHeaders.filter(h => h !== "content-type").join(",");

  const corsHeaders = origin => ({
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Expose-Headers": exposed,
    "X-Content-Type-Options": "nosniff",
  });

  const reply = (body, status, origin, extra = {}) =>
    new Response(body, { status, headers: { ...(origin ? corsHeaders(origin) : { "X-Content-Type-Options": "nosniff" }), ...extra } });

  // env.ALLOW_LOCALHOST must be the string "true" to accept localhost origins.
  const isAllowedOrigin = (origin, env) => {
    if (!origin) return false;
    if (config.allowedOrigins.includes(origin)) return true;
    return env?.ALLOW_LOCALHOST === "true" && LOCAL_ORIGIN.test(origin);
  };

  // Every redirect_uri of a registration request must be on an allowed origin.
  // Returns the parsed document, or null when the request is refused.
  const checkedRegistration = (bytes, env) => {
    let doc;
    try { doc = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
    const uris = doc?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return null;
    const ok = uris.every(u => {
      try { return isAllowedOrigin(new URL(u).origin, env); } catch { return false; }
    });
    return ok ? doc : null;
  };

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");

      const methods = Object.hasOwn(config.routes, url.pathname) ? config.routes[url.pathname] : null;
      if (!methods) return reply("not found", 404);
      if (!isAllowedOrigin(origin, env)) return reply("forbidden", 403);
      const preflight = request.method === "OPTIONS";
      if (!preflight && !methods.includes(request.method)) {
        return reply("method not allowed", 405, origin, { "Allow": methods.join(",") });
      }

      // Per-IP limits (wrangler.toml), preflights included. The bindings do
      // not exist under dev-server.mjs, which passes no limiters.
      const isRegister = url.pathname === config.registerPath;
      const limiter = isRegister && !preflight ? env?.REGISTER_LIMIT : env?.RELAY_LIMIT;
      if (limiter) {
        const { success } = await limiter.limit({ key: clientKey(request.headers.get("cf-connecting-ip")) });
        if (!success) return reply("too many requests", 429, origin, { "Retry-After": "60" });
      }

      if (preflight) {
        const headers = {
          ...corsHeaders(origin),
          "Access-Control-Allow-Methods": [...methods, "OPTIONS"].join(","),
          "Access-Control-Allow-Headers": config.requestHeaders.join(","),
          "Access-Control-Max-Age": "86400",
        };
        // A page on a public origin talking to a relay on the visitor's own
        // machine is a public -> private request; Chrome needs an explicit opt-in.
        if (request.headers.get("access-control-request-private-network") === "true") {
          headers["Access-Control-Allow-Private-Network"] = "true";
        }
        return new Response(null, { status: 204, headers });
      }

      if (Number(request.headers.get("content-length") || 0) > config.maxBodyBytes) {
        return reply("payload too large", 413, origin);
      }

      // Count the bytes actually received; Content-Length can be absent or wrong.
      let body;
      if (request.method !== "GET" && request.method !== "HEAD") {
        body = await readLimited(request.body, config.maxBodyBytes);
        if (body === null) return reply("payload too large", 413, origin);
        if (isRegister) {
          // Forward what was validated, not the original bytes, so the
          // upstream cannot parse the document differently (duplicate keys).
          const doc = checkedRegistration(body, env);
          if (!doc) return reply("redirect_uris must be on an allowed origin", 400, origin);
          body = JSON.stringify(doc);
        }
      }

      const upstreamHeaders = new Headers();
      for (const name of config.requestHeaders) {
        const value = request.headers.get(name);
        if (value) upstreamHeaders.set(name, value);
      }

      // Deliberately no logging here: bearer tokens transit this Worker.
      let upstream;
      try {
        upstream = await fetch(config.upstream + url.pathname + url.search, {
          method: request.method,
          headers: upstreamHeaders,
          body,
          redirect: "manual",
        });
      } catch {
        return reply("upstream unreachable", 502, origin);
      }

      const responseHeaders = new Headers(corsHeaders(origin));
      for (const name of config.responseHeaders) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }

      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    },
  };
}

export default createRelay(defaultConfig);
