// Length-checked XOR compare so the admin token cannot be guessed byte by byte.
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function isAdmin(request, env) {
  const tok = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return Boolean(env.ADMIN_TOKEN) && same(tok, env.ADMIN_TOKEN);
}
export const unauthorized = () => new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
