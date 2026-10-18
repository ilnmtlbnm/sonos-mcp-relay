# sonos-mcp-relay

A CORS relay for the Sonos MCP server, so that a web page can be the MCP
client. `mcp.ws.sonos.com` sends no `Access-Control-Allow-Origin`, which
means a browser cannot call it directly; this Worker forwards three paths
and adds the missing headers. Nothing else.

Used by the Sonos page on trucs.ai. Personal project. Not affiliated with
or endorsed by Sonos.

The upstream is a deployment setting, not something a request can choose,
so the same code can front a different MCP server: see
[Using it for another MCP server](#using-it-for-another-mcp-server).

## Run it

Needs Node 22 or newer for wrangler (the local server and the tests also run
on older Node).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ilnmtlbnm/sonos-mcp-relay)

Or from a clone:

    npx wrangler@4.36.0 login     # once
    npx wrangler@4.36.0 deploy    # prints the URL

The version is pinned on purpose: wrangler runs with your Cloudflare login,
so do not run `@latest` unreviewed. Rate limits need wrangler 4.36 or newer.
The deploy button copies this repo into your account as it is today and does
not follow later fixes; pull them into your copy yourself.

**Stay on the Workers free plan.** Past its daily request limit (100 000) a
free Worker answers with an error instead of being billed, so abuse can take
your relay down for the day but cannot cost money. On a paid plan requests
are billed per million; if you use one, set a spend or usage notification in
the Cloudflare dashboard.

Locally, no account needed, the same code under plain Node (this one accepts
localhost origins):

    node dev-server.mjs           # http://127.0.0.1:8787

Then put the URL in the "relay" box on the page.

## Using it for another MCP server

All deployment settings are in `src/config.js`:

| Setting | Meaning |
| --- | --- |
| `upstream` | Origin of the MCP server, fixed at deploy time. |
| `routes` | Exact path to allowed methods. Other paths get 404, other methods 405. |
| `registerPath` | OAuth dynamic client registration path, or `null`. Its `redirect_uris` must all be on an allowed origin. |
| `allowedOrigins` | Browser origins allowed to call the relay. |
| `requestHeaders` / `responseHeaders` | Headers copied upstream and back. Everything else is dropped. |
| `maxBodyBytes` | Request body limit (64 KB). |

To front another server, edit those values, set the rate limits in
`wrangler.toml`, run `npm test`, and deploy. If the server needs other
request or response headers (for example a different session header), list
them there. The `ALLOW_LOCALHOST` variable in `wrangler.toml` stays
`"false"` for a public deployment.

## Connecting

The page talks to a relay whose URL you set in its "relay" box. There are three ways to get one.

| Option | How | What it sees |
| --- | --- | --- |
| Hosted relay | The page's default. Nothing to set up. | Operated by the page's author. Your tokens and Sonos data pass through it (see Threat model). The code stores and logs nothing, but you are trusting that the deployed code is this code, and you cannot verify that from the outside. |
| Your own Cloudflare Worker | The deploy button above, or `npx wrangler@4.36.0 deploy`. Paste the printed `workers.dev` URL into the relay box. | Only your Cloudflare account sees the traffic. `wrangler.toml` sets Workers Logs to off; check the dashboard, `wrangler tail` and Logpush are account settings it does not control. |
| Local relay | `node dev-server.mjs`, then paste `http://127.0.0.1:8787`. | Nothing leaves your machine except the forwarded request to Sonos. |

Tokens never stay in the relay. The page keeps them in your browser's local storage, next to the OAuth client id the relay registered for you. "Log out" on the page deletes both. Changing the relay URL also clears them, because they were issued through the previous relay. To cut off access on the Sonos side as well, remove the app from the apps authorized on your Sonos account.

The relay answers browser requests only from the origins in `allowedOrigins` (`https://trucs.ai`), plus `http://localhost` and `http://127.0.0.1` on any port when `ALLOW_LOCALHOST` is `"true"`. That flag is on in `dev-server.mjs` and off in `wrangler.toml`, so a deployed relay refuses localhost pages unless you turn it on. Any other origin gets a 403. If you serve the page from somewhere else, add your origin to `src/config.js` before deploying.

Rate limits are per client IP (IPv6 per /64) and apply to the Cloudflare deployments: 120 requests a minute across the forwarded paths, preflights included, and 3 a minute for registration. A client over the limit gets a 429 with `Retry-After: 60`. The local relay has no limits. Both are set in `wrangler.toml`.

A page served over https that calls `http://127.0.0.1` is a mixed-content request. Chrome and Firefox treat loopback as secure and allow it. Chrome also sends a private-network preflight, which the relay answers. Where a browser blocks it, serve the page from localhost or use the Cloudflare option.

## Tools

In manual mode the page asks the Sonos server for its tool list with `tools/list` and shows every tool the server returns, unfiltered. A smaller subset of 12 or 13 tools only matters for a future model-driven mode, where a small model chooses between tools and does better with fewer of them. It does not apply when a person picks the tool.

## What it does, and doesn't

- Forwards only `POST /mcp-oauth/register`, `POST /mcp-oauth/token` and
  `GET|POST|DELETE /mcp` to a hardcoded upstream; other methods get 405.
  It cannot be pointed elsewhere, and does not follow upstream redirects.
- Copies only `authorization`, `content-type`, `accept`,
  `mcp-session-id`, `mcp-protocol-version` upstream, and only
  `content-type`, `mcp-session-id`, `www-authenticate` back. Cookies,
  referer, `Set-Cookie`, `Location` and everything else are dropped.
- Streams the response body back, with CORS headers and
  `X-Content-Type-Options: nosniff` added.
- Stores nothing and logs nothing in its code: bearer tokens transit here.
- Rejects request bodies over 64 KB, counted as they arrive (the upload is
  cancelled at the limit even without a Content-Length).
- Registers OAuth clients only for redirect URIs on an allowed origin.
- Answers 502 with CORS headers when the upstream is unreachable.

## Abuse and cost

The origin allowlist is a browser mechanism. Any script or `curl` can set an
`Origin` header, so the relay does not authenticate callers.

What someone can do with a hosted relay:

- Reach Sonos's three MCP endpoints through the operator's Cloudflare IPs,
  with their own Sonos account's token, within the rate limits.
- Register OAuth clients with Sonos, only for redirect URIs on an allowed
  origin, at most 3 a minute per IP (/64 for IPv6).
- Use up the operator's request quota. The limiter is per Cloudflare
  location and approximate, so it is a brake, not a quota. On the free plan
  the worst case is the relay failing until the daily limit resets.

What they cannot do:

- Use another user's Sonos token. Tokens live in the user's browser and are
  sent only by the page; the relay keeps none.
- Reach any other host, path or method, or send cookies or custom headers
  upstream.
- Use it as a general proxy: the upstream is a constant.

A caller that is not a browser skips the origin check but still needs a
valid Sonos token for everything except registration and the token exchange,
and is bound by the same rate limits and body limit.

## Threat model

- The relay sees, in transit, every access token and refresh token (the
  token response and the `Authorization` header), the OAuth authorization
  code and PKCE verifier, all MCP payloads (household, room and player
  names, what is playing, volume and playback commands), and the client IP,
  which is the rate-limit key. Cloudflare terminates TLS and holds per-IP
  rate-limit counters.
- The operator of a relay has to be trusted. The code does not store or log
  these, but the operator can deploy different code at any time, and a user
  cannot check what is running. Run your own relay or the local one if that
  matters.
- The refresh token is long-lived control of the user's speakers. Logging
  out on the page deletes tokens from the browser; to end access, remove the
  app from the apps authorized on the Sonos account.
- `redirect_uri` is validated twice: by Sonos at authorization time
  (exact match, PKCE, consent screen), and by the relay at registration,
  which refuses redirect URIs outside its allowed origins. State and PKCE
  belong to the page. The authorize step is a browser navigation to Sonos
  and never passes through the relay, which never sees a Sonos password.
- Responses and the relay's own logs are the operator's to configure:
  `wrangler.toml` sets Workers Logs to off, but `wrangler tail`, Logpush and
  Tail Workers are account-side.

## Tests

    npm test              # offline, upstream stubbed (CI runs this on Node 22)
    LIVE=1 node wtest.mjs # adds two real requests; registers a throwaway
                          # OAuth client with Sonos, so not for CI
