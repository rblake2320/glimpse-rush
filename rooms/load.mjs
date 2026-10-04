// Room load test against a deployed room service: N real WebSocket players join one room at once.
// Measures connect->hello (join) latency and how long until every player has seen every other player's name,
// then confirms player N+1 is refused when N is the room cap.
//   node rooms/load.mjs [wss://glimpse-rush-rooms.rblake2320.workers.dev] [players=50]
const BASE = process.argv[2] || "wss://glimpse-rush-rooms.rblake2320.workers.dev";
const N = Number(process.argv[3] || 50);
const room = "gr-" + Math.random().toString(36).slice(2, 8).padEnd(6, "x");
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };

function player(i) {
  return new Promise((ok, no) => {
    const t0 = performance.now();
    const ws = new WebSocket(`${BASE}/room/${room}`);
    const c = { ws, seen: new Set(), i };
    const timer = setTimeout(() => no(new Error(`player ${i} got no hello in 15 s`)), 15000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "hello") {
        clearTimeout(timer); c.join = performance.now() - t0; c.id = m.id;
        for (const p of m.peers) if (p.presence?.nick) c.seen.add(p.presence.nick);
        ws.send(JSON.stringify({ t: "presence", patch: { nick: "P" + i } }));
        ok(c);
      } else if (m.t === "peer" && m.presence?.nick) c.seen.add(m.presence.nick);
    };
    ws.onerror = () => { clearTimeout(timer); no(new Error(`player ${i} socket error`)); };
  });
}

const t0 = performance.now();
const players = await Promise.all(Array.from({ length: N }, (_, i) => player(i)));
const joined = performance.now() - t0;
const tConv = performance.now();
while (players.some((p) => p.seen.size < N) && performance.now() - tConv < 20000) await new Promise((r) => setTimeout(r, 50));
const converge = performance.now() - tConv;
const behind = players.filter((p) => p.seen.size < N).length;
const joins = players.map((p) => p.join);

// one more than the cap must be refused
let refused = "n/a";
if (N >= 50) {
  refused = await new Promise((r) => {
    const ws = new WebSocket(`${BASE}/room/${room}`);
    ws.onmessage = (e) => { if (JSON.parse(e.data).t === "hello") { ws.close(); r("ADMITTED"); } };
    ws.onerror = () => r("refused");
    ws.onclose = () => r("refused");
    setTimeout(() => r("timeout"), 8000);
  });
}
players.forEach((p) => p.ws.close());
const res = { players: N, all_joined_ms: Math.round(joined), join_p50_ms: Math.round(pct(joins, 0.5)), join_p95_ms: Math.round(pct(joins, 0.95)),
  join_max_ms: Math.round(Math.max(...joins)), everyone_sees_everyone_ms: Math.round(converge), players_behind: behind, player_51: refused };
console.log(JSON.stringify(res));
const ok = behind === 0 && res.join_p95_ms < 3000 && (N < 50 || refused === "refused");
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
