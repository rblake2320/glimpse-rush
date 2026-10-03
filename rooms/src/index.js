// Glimpse Rush live rooms: one Durable Object per room code, WebSockets with hibernation.
// Protocol (JSON text frames):
//   server → client  {t:"hello", id, peers:[{id, presence}]}   on join
//                    {t:"peer", id, presence}                    a peer joined or changed presence
//                    {t:"leave", id}                             a peer left
//                    {t:"pong", now, id}                         reply to ping (clock sync)
//   client → server  {t:"presence", patch}                       shallow-merged into the sender's presence
//                    {t:"ping", id}
// The room relays presence only; game rules run in the clients exactly as before (host publishes the game state).

export const LIMITS = { peers: 50, presenceBytes: 16384, msgsPerSec: 30, nameMax: 40 };
const NAME = /^gr-[a-z0-9]{6}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const w = url.pathname.match(/^\/(?:api\/)?world\/([02])$/);
    if (w) return worldFetch(request, env.WORLD, w[1]);
    const m = url.pathname.match(/^\/(?:api\/)?room\/([^/]+)$/);
    if (!m) return new Response("not found", { status: 404 });
    return roomFetch(request, env.ROOM, decodeURIComponent(m[1]));
  },
};

// Shared by this Worker and the Pages Function that proxies /api/room/<name>.
export function roomFetch(request, ns, name) {
  if (!NAME.test(name)) return new Response("bad room name", { status: 400 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
  return ns.get(ns.idFromName(name)).fetch(request);
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.rate = new Map(); // socket id -> {sec, n}; lost on hibernation, which is fine
  }

  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1 || ws.readyState === 0);
  }

  async fetch(request) {
    if (this.sockets().length >= LIMITS.peers) return new Response("room full", { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    const id = crypto.randomUUID().slice(0, 12);
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id });
    await this.ctx.storage.put("p:" + id, {});
    const peers = [];
    for (const ws of this.sockets()) {
      const pid = ws.deserializeAttachment()?.id;
      if (!pid || pid === id) continue;
      peers.push({ id: pid, presence: (await this.ctx.storage.get("p:" + pid)) ?? {} });
    }
    server.send(JSON.stringify({ t: "hello", id, peers }));
    this.broadcast({ t: "peer", id, presence: {} }, id);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(msg, exceptId) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      if (ws.deserializeAttachment()?.id === exceptId) continue;
      try { ws.send(s); } catch { /* closing socket */ }
    }
  }

  limited(id) {
    const sec = Math.floor(Date.now() / 1000), r = this.rate.get(id);
    if (!r || r.sec !== sec) { this.rate.set(id, { sec, n: 1 }); return false; }
    return ++r.n > LIMITS.msgsPerSec;
  }

  async webSocketMessage(ws, data) {
    const id = ws.deserializeAttachment()?.id;
    if (!id || typeof data !== "string" || data.length > LIMITS.presenceBytes) return;
    if (this.limited(id)) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === "ping") return ws.send(JSON.stringify({ t: "pong", now: Date.now(), id: m.id }));
    if (m.t !== "presence" || !m.patch || typeof m.patch !== "object" || Array.isArray(m.patch)) return;
    const merged = { ...((await this.ctx.storage.get("p:" + id)) ?? {}), ...m.patch };
    if (JSON.stringify(merged).length > LIMITS.presenceBytes) return;
    await this.ctx.storage.put("p:" + id, merged);
    // everyone, including the sender, gets the change so each client can confirm its own presence landed
    this.broadcast({ t: "peer", id, presence: merged });
  }

  async gone(ws) {
    const id = ws.deserializeAttachment()?.id;
    if (!id) return;
    this.rate.delete(id);
    await this.ctx.storage.delete("p:" + id);
    this.broadcast({ t: "leave", id }, id);
    if (this.sockets().filter((s) => s !== ws).length === 0) await this.ctx.storage.deleteAll();
  }

  async webSocketClose(ws, code, reason) {
    await this.gone(ws);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    await this.gone(ws);
  }
}

// ---------------------------------------------------------------- World Live board
// One object per World Live queue ("0" plain, "2" scrambled). Rounds are minutes of server time (spec §3); players
// post one score per round and everyone connected gets the round's live board and the number of people playing.
//   client → server  {t:"hello", name}            {t:"score", k, score, s, el}
//   server → client  {t:"board", k, online, rows:[{name, score, s, el}], players}
export const WORLD = { maxScore: 8910, nameMax: 20, top: 20, keepRounds: 3 };

export function worldFetch(request, ns, queue) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
  return ns.get(ns.idFromName("world-" + queue)).fetch(request);
}

export class WorldBoard {
  constructor(ctx) {
    this.ctx = ctx;
    this.rounds = new Map(); // k -> Map(socketId -> {name, score, s, el})
    this.pending = null;
  }
  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1); }
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    const id = crypto.randomUUID().slice(0, 12);
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, name: "Player" });
    server.send(JSON.stringify(this.board(Math.floor(Date.now() / 60000))));
    this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }
  board(k) {
    const r = this.rounds.get(k) ?? new Map();
    const rows = [...r.values()].sort((a, b) => b.score - a.score || a.el - b.el).slice(0, WORLD.top);
    return { t: "board", k, online: this.sockets().length, players: r.size, rows };
  }
  // batch updates: at most one broadcast per 250 ms, however many scores arrive
  schedule() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const k = Math.floor(Date.now() / 60000);
      const msg = JSON.stringify(this.board(k));
      for (const ws of this.sockets()) { try { ws.send(msg); } catch {} }
    }, 250);
  }
  webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > 512) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    const att = ws.deserializeAttachment() ?? {};
    if (m.t === "hello") {
      att.name = String(m.name || "Player").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, WORLD.nameMax) || "Player";
      ws.serializeAttachment(att); return;
    }
    if (m.t !== "score") return;
    const now = Math.floor(Date.now() / 60000), k = Number(m.k);
    // only the current round (or the one that just ended, for answers in its last seconds)
    if (!Number.isInteger(k) || k > now || k < now - 1) return;
    const score = Number(m.score), s = Number(m.s), el = Number(m.el);
    if (!Number.isInteger(score) || score < 0 || score > WORLD.maxScore || !Number.isInteger(el) || el < 0 || el > 40000) return;
    if (!this.rounds.has(k)) this.rounds.set(k, new Map());
    const r = this.rounds.get(k);
    if (r.has(att.id)) return; // one score per player per round
    r.set(att.id, { name: att.name, score, s: Number.isInteger(s) ? s : null, el });
    for (const old of this.rounds.keys()) if (old < now - WORLD.keepRounds) this.rounds.delete(old);
    this.schedule();
  }
  webSocketClose(ws, code, reason) { this.schedule(); try { ws.close(code === 1005 ? 1000 : code, reason); } catch {} }
  webSocketError() { this.schedule(); }
}
