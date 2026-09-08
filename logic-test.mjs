// Tests for the browser client's parsing, importing the real functions.
import { parseSse, toolError, resultText } from "../sonos-mcp.js";

let pass = 0, fail = 0;
const chk = (name, cond, got) => { cond ? (pass++, console.log("  ok  ", name)) : (fail++, console.log("  FAIL", name, "->", JSON.stringify(got))); };

// --- SSE framing ----------------------------------------------------------
const single = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
chk("single event", parseSse(single, 1)?.result.ok === true, parseSse(single, 1));

const multi =
  'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n' +
  'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n';
chk("picks the reply matching our id among notifications", parseSse(multi, 7)?.id === 7, parseSse(multi, 7));

const crlf = 'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\r\n\r\n';
chk("CRLF stream", parseSse(crlf, 2)?.id === 2, parseSse(crlf, 2));

const multiline = 'data: {"jsonrpc":"2.0",\ndata: "id":3,"result":{}}\n\n';
chk("multi-line data joined with newline", parseSse(multiline, 3)?.id === 3, parseSse(multiline, 3));

chk("no message -> null", parseSse("event: ping\n\n", 1) === null, parseSse("event: ping\n\n", 1));
chk("garbage data ignored", parseSse("data: {nope\n\n", 1) === null, "threw?");

// --- tool-level errors inside a 200 --------------------------------------
const STALE = "Error: The group_id is no longer valid, so nothing happened — the Sonos system has changed since it was issued. Call get_households_and_groups_and_players for a current one, then try again.";
chk("detects Sonos stale-group error text", toolError({ content: [{ type: "text", text: STALE }] }) === STALE, "missed");
chk("detects isError flag", !!toolError({ isError: true, content: [] }), "missed");
chk("clean result is not an error", toolError({ content: [{ type: "text", text: '{"volume":26}' }] }) === null, "false positive");
chk("resultText joins text parts", resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }) === "a\nb", "?");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
