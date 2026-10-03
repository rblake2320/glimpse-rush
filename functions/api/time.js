// Server clock for World Live: every device aligns its rounds to this time (spec §3: all times are server time).
export const onRequestGet = () =>
  new Response(JSON.stringify({ now: Date.now() }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
