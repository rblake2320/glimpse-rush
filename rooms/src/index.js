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
