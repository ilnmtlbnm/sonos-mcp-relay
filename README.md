# sonos-mcp-proxy

A CORS relay for the Sonos MCP server, so that a web page can be the MCP
client. `mcp.ws.sonos.com` sends no `Access-Control-Allow-Origin`, which
means a browser cannot call it directly; this Worker forwards three paths
and adds the missing headers. Nothing else.

Personal project. Not affiliated with or endorsed by Sonos.

## Run it

Hosted, on Cloudflare (free tier is far beyond hobby use):

    npx wrangler deploy

Locally, no account needed — the same code under plain Node:

    node dev-server.mjs          # http://127.0.0.1:8787

Then put the URL in the "relay" box on the page. A local relay works
from the deployed page too (the Worker answers Chrome's Private Network
Access preflight).

## What it does, and doesn't

- Forwards only `POST /mcp-oauth/register`, `POST /mcp-oauth/token`,
  `POST|DELETE|GET /mcp`, to a hardcoded upstream. It cannot be pointed
  elsewhere.
- Copies only `authorization`, `content-type`, `accept`,
  `mcp-session-id`, `mcp-protocol-version` upstream. Cookies, referer
  and everything else are dropped.
- Streams the response body back unchanged, with CORS headers added and
  `Mcp-Session-Id` / `WWW-Authenticate` exposed.
- Stores nothing. Logs nothing — bearer tokens transit here, and the
  code says so.
- Rejects bodies over 64 KB.

What it cannot do: authenticate callers. The origin allowlist
(`https://trucs.ai` and localhost) is a browser mechanism; any script
can set an `Origin` header. So the relay does not protect *itself* from
strangers — it protects *users* only in that it holds no state and
forwards nothing but their own request. A stranger cannot obtain
anyone's token through it; they can burn the operator's request quota.
If you run one publicly, add a per-IP rate-limiting rule in the
Cloudflare dashboard.

The `authorize` step is a browser navigation to Sonos itself and never
passes through the relay. The relay never sees a Sonos password.

## Tests

    node wtest.mjs        # offline, upstream stubbed
    node logic-test.mjs   # the page's parsing, importing the real code
    LIVE=1 node wtest.mjs # adds two real requests; registers a throwaway
                          # OAuth client with Sonos, so not for CI
