import { summary } from "../../_lib/store.js";

// Length-checked XOR compare so the token cannot be guessed byte by byte.
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function onRequestGet({ request, env }) {
  const tok = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.ADMIN_TOKEN || !same(tok, env.ADMIN_TOKEN)) {
    return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  return new Response(JSON.stringify(await summary(env.DB, Date.now())), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
