// Everything deployment-specific lives here. To relay another MCP server,
// change these values and nothing else. The upstream is fixed at deploy time;
// no request can choose or influence it.
export default {
  // Origin of the MCP server. No trailing slash.
  upstream: "https://mcp.ws.sonos.com",

  // Exact paths that are forwarded, and the methods each accepts.
  // Anything else gets 404 (path) or 405 (method).
  routes: {
    "/mcp": ["GET", "POST", "DELETE"],
    "/mcp-oauth/token": ["POST"],
    "/mcp-oauth/register": ["POST"],
  },

  // Dynamic client registration path, or null. Its redirect_uris must all be
  // on an allowed origin, and it gets the stricter REGISTER_LIMIT.
  registerPath: "/mcp-oauth/register",

  // Browser origins allowed to call the relay (exact match).
  allowedOrigins: ["https://trucs.ai"],

  // Request headers copied upstream (lowercase). Everything else is dropped.
  requestHeaders: ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"],

  // Response headers copied back (lowercase). Everything else is dropped.
  // All but content-type are also exposed to the page's JavaScript.
  responseHeaders: ["content-type", "mcp-session-id", "www-authenticate"],

  // Largest request body accepted, in bytes. OAuth and MCP payloads are a few KB.
  maxBodyBytes: 64 * 1024,
};
