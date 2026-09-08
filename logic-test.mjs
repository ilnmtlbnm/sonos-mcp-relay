// Checks the two parsing algorithms used by ../index.html and ../sonos-mcp.js
// against the real Sonos shapes. Replicates the algorithms (they are not
// exported); keep in sync if either changes.
let pass = 0, fail = 0;
const chk = (n, c, got) => { c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, "->", JSON.stringify(got))); };

// --- findProperty: tool args are snake_case, our hints are camelCase ---
const flatten = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function findProperty(schema, hint) {
  const keys = Object.keys(schema?.properties || {});
  const h = flatten(hint);
  let m = keys.find(k => flatten(k) === h);
  if (!m) m = keys.find(k => flatten(k).includes(h));
  return m || hint;
}
const volSchema = { properties: { group_id: {}, volume: {} } };
chk("groupId -> group_id", findProperty(volSchema, "groupId") === "group_id", findProperty(volSchema, "groupId"));
chk("volume -> volume", findProperty(volSchema, "volume") === "volume", findProperty(volSchema, "volume"));
chk("playerId -> player_id", findProperty({ properties: { player_id: {} } }, "playerId") === "player_id", "?");
chk("already-camel server still works", findProperty({ properties: { groupId: {} } }, "groupId") === "groupId", "?");

// --- SSE: multiple events in one response must not be concatenated ---
function parseSse(text, wantId) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch {}
  }
  return messages.find(m => m.id === wantId) ?? messages[messages.length - 1] ?? null;
}
const single = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
chk("single event", parseSse(single, 1)?.result.ok === true, parseSse(single, 1));

const multi =
  "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n\n" +
  "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"tools\":[]}}\n\n";
chk("picks the reply matching our id", parseSse(multi, 7)?.id === 7, parseSse(multi, 7));
// the old algorithm concatenated both payloads into one unparseable string
let old = ""; for (const l of multi.split("\n")) if (l.startsWith("data:")) old += l.slice(5).trim();
let oldBroke = false; try { JSON.parse(old); } catch { oldBroke = true; }
chk("old concatenating parser would have thrown", oldBroke, old.slice(0, 60));

const crlf = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\r\n\r\n";
chk("CRLF stream", parseSse(crlf, 2)?.id === 2, parseSse(crlf, 2));

const wrapped = "data: {\"jsonrpc\":\"2.0\",\"id\":3,\n data: \"result\":{}}\n\n";
chk("no crash on malformed", parseSse(wrapped, 3) === null || true, "ok");

// --- group rendering against the REAL households response shape ---
const real = [{ name: "Unnamed Household 1", householdId: "Sonos_x", groups: [
  { groupId: "RINCON_A:1", playbackState: "PLAYBACK_STATE_PAUSED", players: [{ name: "Cuisine", playerId: "RINCON_P1" }] },
  { groupId: "RINCON_B:2", playbackState: "PLAYBACK_STATE_IDLE", players: [{ name: "Chambre", playerId: "RINCON_P2" }] }]}];
function findArrays(obj, key, acc = []) {
  if (Array.isArray(obj)) { for (const i of obj) findArrays(i, key, acc); return acc; }
  if (obj && typeof obj === "object") for (const k in obj) {
    if (k === key && Array.isArray(obj[k])) acc.push(...obj[k]); else findArrays(obj[k], key, acc);
  }
  return acc;
}
const groups = findArrays(real, "groups");
const flat = findArrays(real, "players");
chk("finds 2 groups", groups.length === 2, groups.length);
const g = groups[0];
const gPlayers = g.players ?? flat.filter(p => (g.playerIds && g.playerIds.includes(p.id)) || p.groupId === g.groupId);
chk("resolves nested players", gPlayers.length === 1 && gPlayers[0].name === "Cuisine", gPlayers);
chk("title falls back to coordinator name", (g.name || gPlayers[0]?.name || g.groupId) === "Cuisine", "?");
const oldPlayers = flat.filter(p => (g.playerIds && g.playerIds.includes(p.id)) || p.groupId === g.groupId);
chk("old filter would have rendered empty", oldPlayers.length === 0, oldPlayers);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
