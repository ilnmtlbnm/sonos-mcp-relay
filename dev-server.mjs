// Runs the real src/index.js under plain Node, no wrangler, no account.
//   node dev-server.mjs        then set PROXY = "http://localhost:8787"
import { createServer } from "node:http";
import worker from "./src/index.js";

const PORT = process.env.PORT || 8787;

createServer(async (req, res) => {
  const url = "http://localhost:" + PORT + req.url;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req;
  const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });

  const out = await worker.fetch(request);
  // Method, path, status and origin only -- never auth headers or bodies.
  // Origin matters because localhost and 127.0.0.1 are separate origins with
  // separate localStorage, so switching spelling silently logs you out.
  const origin = req.headers.origin || "-";
  console.log(`${new Date().toISOString().slice(11, 19)}  ${req.method.padEnd(7)} ${req.url.padEnd(22)} ${String(out.status).padEnd(4)} ${origin}`);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (out.body) {
    for await (const chunk of out.body) res.write(chunk);
  }
  res.end();
})
  .on("error", e => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(`port ${PORT} is already in use. Run: PORT=8788 node dev-server.mjs`);
    process.exit(1);
  })
  // Bind 127.0.0.1 rather than every interface: binding :: would silently
  // coexist with an IPv4 listener on the same port and serve only half the
  // requests, depending on how localhost resolves.
  .listen(PORT, "127.0.0.1", () => console.log(`sonos relay on http://127.0.0.1:${PORT}`));
