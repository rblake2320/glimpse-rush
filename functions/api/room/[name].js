// /api/room/<name>: WebSocket into that room's Durable Object (service: rooms/src/index.js).
const NAME = /^gr-[a-z0-9]{6}$/;

export async function onRequest({ request, env, params }) {
  const name = String(params.name || "");
  if (!NAME.test(name)) return new Response("bad room name", { status: 400 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
  return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(request);
}
