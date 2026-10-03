import { summary } from "../../_lib/store.js";
import { isAdmin, unauthorized } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return unauthorized();
  return new Response(JSON.stringify(await summary(env.DB, Date.now())), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
