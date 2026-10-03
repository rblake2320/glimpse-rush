// Pure validation/sanitising for playtest payloads. No I/O, so it is unit-tested directly.
export const EVENT_TYPES = new Set([
  "session_start", "round_start", "freeze", "answer", "freeze_fail", "round_end",
  "round_abandon", "blitz_end", "screen", "feedback_open",
]);
export const TAGS = new Set([
  "fun", "too_hard", "too_easy", "unfair_scoring", "confusing", "too_slow",
  "photo_issue", "answer_rejected", "layout", "performance", "other",
]);
export const LIMITS = { body: 32768, batch: 50, text: 1000, short: 80, data: 2000, perMinute: 400 };

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const int = (v) => (Number.isFinite(+v) ? Math.trunc(+v) : null);
const SID = /^[a-z0-9-]{16,48}$/;

export function validSid(sid) { return typeof sid === "string" && SID.test(sid); }

export function cleanEvent(e, now) {
  if (!e || typeof e !== "object" || !EVENT_TYPES.has(e.type)) return null;
  let data = null;
  if (e.data && typeof e.data === "object") {
    data = JSON.stringify(e.data);
    if (data.length > LIMITS.data) data = JSON.stringify({ truncated: true });
  }
  const ts = int(e.ts);
  return {
    type: e.type,
    ts: ts !== null && Math.abs(ts - now) < 864e5 * 2 ? ts : now,
    mode: clip(e.mode, LIMITS.short),
    round_no: int(e.round_no),
    photo_id: clip(e.photo_id, LIMITS.short),
    grid: int(e.grid),
    data,
  };
}

export function cleanBatch(body, now) {
  if (!body || !validSid(body.sid) || !Array.isArray(body.events)) return null;
  const events = body.events.slice(0, LIMITS.batch).map((e) => cleanEvent(e, now)).filter(Boolean);
  const m = body.meta && typeof body.meta === "object" ? body.meta : {};
  return {
    sid: body.sid,
    meta: { device: clip(m.device, LIMITS.short), viewport: clip(m.viewport, 20), lang: clip(m.lang, 20), build: clip(m.build, 40) },
    events,
  };
}

export function cleanFeedback(body) {
  if (!body || !validSid(body.sid)) return null;
  const kind = ["general", "round", "dispute"].includes(body.kind) ? body.kind : null;
  if (!kind) return null;
  let rating = int(body.rating);
  if (kind === "general" && !(rating >= 1 && rating <= 5)) rating = null;
  if (kind === "round" && !(rating === 0 || rating === 1)) rating = null;
  if (kind === "dispute") rating = null;
  const tags = (Array.isArray(body.tags) ? body.tags : []).filter((t) => TAGS.has(t)).join(",") || null;
  let context = null;
  if (body.context && typeof body.context === "object") {
    context = JSON.stringify(body.context);
    if (context.length > 4000) context = context.slice(0, 4000);
  }
  const fb = {
    sid: body.sid, kind, rating, tags,
    liked: clip(body.liked, LIMITS.text), disliked: clip(body.disliked, LIMITS.text), bug: clip(body.bug, LIMITS.text),
    answer: clip(body.answer, LIMITS.short), photo_id: clip(body.photo_id, LIMITS.short),
    contact: clip(body.contact, 120), context,
  };
  const hasContent = rating !== null || tags || fb.liked || fb.disliked || fb.bug || fb.answer;
  return hasContent ? fb : null;
}
