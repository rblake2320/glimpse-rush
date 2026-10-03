// /api/world/<0|2>: WebSocket into the live World Live board for that queue (service: rooms/src/index.js WorldBoard).
export async function onRequest({ request, env, params }) {
  const q = String(params.q || "");
  if (q !== "0" && q !== "2") return new Response("unknown queue", { status: 400 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
  return env.WORLD.get(env.WORLD.idFromName("world-" + q)).fetch(request);
}
