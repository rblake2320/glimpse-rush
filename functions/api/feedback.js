import { LIMITS, cleanFeedback } from "../_lib/ingest.js";
import { saveFeedback } from "../_lib/store.js";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (raw.length > LIMITS.body) return json({ error: "too_large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const fb = cleanFeedback(body);
  if (!fb) return json({ error: "invalid" }, 400);
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE sid=? AND srv_ts>?").bind(fb.sid, now - 60000).first();
  if ((recent?.n ?? 0) >= 20) return json({ error: "rate_limited" }, 429);
  await saveFeedback(env.DB, fb, now);
  return json({ ok: true });
}
