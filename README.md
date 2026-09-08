# sonos-mcp-proxy

Minimal Cloudflare Worker that adds CORS headers to `mcp.ws.sonos.com`,
which sends none. Relays only `/mcp`, `/mcp-oauth/token`, and
`/mcp-oauth/register` for the `trucs.ai` origin (plus localhost for dev).
No storage, no auth, no logging — it just forwards headers and streams
the response body.

## Deploy

```
npx wrangler deploy
```

## Security rationale

A hardcoded upstream host plus a path allowlist keep this from becoming
an open proxy; an origin allowlist plus reflected (never `*`)
`Access-Control-Allow-Origin` keep it from leaking bearer tokens to
arbitrary sites, since Authorization headers pass through untouched.
