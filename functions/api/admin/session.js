import { sessionRows } from "../../_lib/store.js";
import { validSid } from "../../_lib/ingest.js";
import { isAdmin, unauthorized } from "../../_lib/auth.js";

// One session's raw rows: lets the wire map prove its own actions landed, and answers data-deletion requests.
export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return unauthorized();
  const sid = new URL(request.url).searchParams.get("sid") ?? "";
  if (!validSid(sid)) return new Response("bad sid", { status: 400 });
  return new Response(JSON.stringify(await sessionRows(env.DB, sid)), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
