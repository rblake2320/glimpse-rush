import { LIMITS, cleanBatch } from "../_lib/ingest.js";
import { rateLimited, saveBatch } from "../_lib/store.js";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (raw.length > LIMITS.body) return json({ error: "too_large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const now = Date.now();
  const batch = cleanBatch(body, now);
  if (!batch) return json({ error: "invalid" }, 400);
  if (await rateLimited(env.DB, batch.sid, now)) return json({ error: "rate_limited" }, 429);
  const country = request.cf?.country ?? request.headers.get("cf-ipcountry") ?? null;
  const n = await saveBatch(env.DB, batch, country, now);
  return json({ ok: true, saved: n });
}
