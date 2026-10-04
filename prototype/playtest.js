/* Glimpse Rush playtest layer: anonymous telemetry (with consent) + in-game feedback.
   Loaded after the game script. It wraps game functions; it never edits game state.
   Does nothing off http(s) (e.g. opened as a file) or on localhost unless ?pt=1. */
(() => {
  "use strict";
  const BUILD = "playtest-1";
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const HOSTED = /^https?:$/.test(location.protocol) && (!local || /[?&]pt=1/.test(location.search));
  if (!HOSTED || typeof S === "undefined") return;

  const ls = {
    get(k) { try { return localStorage.getItem("gr.pt." + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("gr.pt." + k, v); } catch { /* private mode */ } },
  };
  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2).padEnd(24, "0") + Date.now().toString(16));
  // Owner/team devices: open the site once with ?owner=1 and this browser's plays are stored but never counted in the stats.
  if (/[?&]owner=1/.test(location.search)) { ls.set("owner", "1"); ls.set("sid", ""); }
  const owner = ls.get("owner") === "1";
  let sid = ls.get("sid");
  if (owner && sid && !sid.startsWith("5e5e5e5e")) sid = "";
  if (!sid) { sid = owner ? "5e5e5e5e-owner-" + rid().replace(/-/g, "").slice(0, 16) : rid(); }
  let consent = ls.get("consent"); // "yes" | "no" | null
  if (consent === "yes") ls.set("sid", sid);

  const meta = () => ({
    device: (/Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? "mobile" : "desktop") + (matchMedia("(pointer:coarse)").matches ? "-touch" : "-mouse"),
    viewport: innerWidth + "x" + innerHeight, lang: navigator.language, build: BUILD,
  });

  const ua = navigator.userAgent;
  const platform = () => ({
    os: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios" : /Android/.test(ua) ? "android"
      : /Windows/.test(ua) ? "windows" : /Mac OS X/.test(ua) ? "mac" : /CrOS/.test(ua) ? "chromeos" : /Linux/.test(ua) ? "linux" : "other",
    browser: /SamsungBrowser/.test(ua) ? "samsung" : /Edg\//.test(ua) ? "edge" : /OPR\//.test(ua) ? "opera" : /FxiOS|Firefox/.test(ua) ? "firefox"
      : /CriOS|Chrome/.test(ua) ? "chrome" : /Safari/.test(ua) ? "safari" : "other",
    inapp: /FBAN|FBAV|Instagram|Line\/|wv\)|GSA\//.test(ua),
    screen: screen.width + "x" + screen.height, dpr: Math.round(devicePixelRatio * 100) / 100,
    net: navigator.connection?.effectiveType ?? null, save_data: !!navigator.connection?.saveData,
    standalone: matchMedia("(display-mode: standalone)").matches,
  });
  // page speed from the browser's own timing (ms)
  const pageTiming = () => {
    const n = performance.getEntriesByType("navigation")[0];
    if (!n) return null;
    const r = (v) => (v > 0 ? Math.round(v) : null);
    return { ttfb: r(n.responseStart), dom_ready: r(n.domContentLoadedEventEnd), load: r(n.loadEventEnd), kb: n.transferSize ? Math.round(n.transferSize / 1024) : null };
  };
  const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

  /* ---------- event queue ---------- */
  let q = [];
  const track = (type, f = {}) => {
    if (consent !== "yes") return;
    q.push({ type, ts: Date.now(), mode: f.mode ?? null, round_no: f.round_no ?? null, photo_id: f.photo_id ?? null, grid: f.grid ?? null, data: f.data ?? null });
    if (q.length > 200) q = q.slice(-200);
  };
  const flush = (beacon) => {
    if (consent !== "yes" || !q.length) return;
    const batch = q.slice(0, 50);
    const body = JSON.stringify({ sid, meta: meta(), events: batch });
    if (beacon && navigator.sendBeacon) {
      if (navigator.sendBeacon("/api/e", new Blob([body], { type: "application/json" }))) q = q.slice(batch.length);
      return;
    }
    const t0 = performance.now();
    fetch("/api/e", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true })
      .then((r) => { apiMs.push(Math.round(performance.now() - t0)); if (apiMs.length > 50) apiMs.shift(); if (r.ok || r.status === 400) q = q.slice(batch.length); })
      .catch(() => {});
  };
  setInterval(() => flush(false), 4000);
  const apiMs = [];

  /* ---------- play time: active = page visible; heartbeat every 30 s and whenever the page is hidden ---------- */
  const visit = rid().slice(0, 12); // one page load; a player (sid) has many visits
  let activeMs = 0, visibleSince = document.hidden ? null : performance.now(), rounds = 0;
  const active = () => activeMs + (visibleSince !== null ? performance.now() - visibleSince : 0);
  const heartbeat = (final) => {
    const roomRtt = typeof G !== "undefined" && G.room && G.room.rtt ? G.room.rtt : null;
    const roomJoin = typeof G !== "undefined" && G.room && G.room.joinMs ? G.room.joinMs : null;
    track("heartbeat", { mode: modeOf(S.R), data: { visit, active_ms: Math.round(active()), total_ms: Math.round(performance.now()), rounds,
      screen: S.screen, api_ms: median(apiMs), room_rtt: roomRtt, room_join_ms: roomJoin, final: !!final } });
  };
  setInterval(() => { if (!document.hidden) heartbeat(false); }, 30000);

  /* ---------- errors on the tester's device (deduped, max 10 per visit) ---------- */
  const seenErr = new Set();
  const reportError = (kind, msg, where, stack) => {
    const key = kind + "|" + msg + "|" + where;
    if (seenErr.has(key) || seenErr.size >= 10) return;
    seenErr.add(key);
    track("client_error", { mode: modeOf(S.R), photo_id: S.R && S.R.photo ? String(S.R.photo.slug ?? S.R.photo.id) : null,
      data: { kind, msg: String(msg).slice(0, 200), where: String(where || "").slice(0, 160), stack: String(stack || "").split("\n").slice(0, 4).join(" | ").slice(0, 400), screen: S.screen } });
    flush(false);
  };
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.tagName === "IMG" || t.tagName === "SCRIPT" || t.tagName === "LINK")) {
      reportError("resource", t.tagName.toLowerCase() + " failed to load", (t.currentSrc || t.src || t.href || "").replace(location.origin, "").slice(0, 160));
    } else reportError("js", e.message, `${(e.filename || "").replace(location.origin, "")}:${e.lineno}:${e.colno}`, e.error && e.error.stack);
  }, true);
  addEventListener("unhandledrejection", (e) => reportError("promise", e.reason && (e.reason.message || e.reason), "", e.reason && e.reason.stack));

  const abandonIfOpen = (reason) => {
    const R = S.R;
    // a round that started and has not been reported (finished) yet; works whether or not the screen already switched
    if (R && !R._rep && R.phase !== "RESULTS" && (reason !== "closed" || S.screen === "play")) {
      R._rep = 1;
      track("round_abandon", { mode: modeOf(R), round_no: R.roundNo, photo_id: R.photo && R.photo.id, grid: R.N,
        data: { reason, phase: R.phase, frozen: !!R.frozen, freezes: R.freezesUsed, ms: Math.round(performance.now() - (R._t0 || 0)) } });
    }
  };
  addEventListener("pagehide", () => { abandonIfOpen("closed"); heartbeat(true); flush(true); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (visibleSince !== null) { activeMs += performance.now() - visibleSince; visibleSince = null; } heartbeat(true); flush(true); }
    else visibleSince = performance.now();
  });

  /* ---------- wrap the game ---------- */
  const wrap = (name, fn) => {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function (...a) { return fn(orig, a, this); };
  };
  const imgMs = (photo) => {
    if (!photo || !photo.src || photo.src.startsWith("data:")) return null;
    const e = performance.getEntriesByName(new URL(photo.src, location.href).href)[0];
    return e ? Math.round(e.duration) : null;
  };
  const safe = (f) => { try { f(); } catch (e) { /* telemetry must never break the game */ } };
  const modeOf = (R) => (R && R.mode === "world" && R.scr ? "world_scr" : R ? R.mode : null);
  const pid = (R) => (R && R.photo ? String(R.photo.slug ?? R.photo.id) : null);

  wrap("run", (orig, [R]) => {
    const out = orig(R);
    safe(() => {
      R._t0 = performance.now(); rounds++;
      track("round_start", { mode: modeOf(R), round_no: R.roundNo, photo_id: pid(R), grid: R.N,
        data: { scr: R.scr, hint: !!R.hint, seed: R.seed, custom: !!(R.photo && R.photo.custom),
          img_ms: imgMs(R.photo) } }); // how long the photo took to download (null if not yet loaded or embedded)
    });
    return out;
  });

  wrap("freeze", (orig, a) => {
    const R = S.R, before = R ? R.freezesUsed : 0;
    const out = orig(...a);
    safe(() => {
      if (R && R.freezesUsed > before && R.frozen) {
        track("freeze", { mode: modeOf(R), round_no: R.roundNo, photo_id: pid(R), grid: R.N,
          data: { n: R.frozen.freezeNo, el: R.frozen.el, shown: R.frozen.s, final: !!R.frozen.inFinal } });
      }
    });
    return out;
  });

  wrap("matchAnswer", (orig, a) => {
    const m = orig(...a);
    safe(() => {
      const R = S.R;
      if (R && R.frozen && S.screen === "play") {
        const text = String(a[0] ?? "").trim().slice(0, 80);
        if (m.kind === "wrong") (R._wrong = R._wrong || []).push(text);
        track("answer", { mode: modeOf(R), round_no: R.roundNo, photo_id: pid(R), grid: R.N,
          data: { kind: m.kind, why: m.why, text, n: R.frozen.freezeNo,
            rt: Math.max(0, Math.round(GAME.ANSWER_WINDOW_MS - (R.frozen.deadline - performance.now()))) } }); // ms from freeze to submit
      }
    });
    return m;
  });

  wrap("failFreeze", (orig, a) => {
    const R = S.R, had = R && R.frozen, n = had ? R.frozen.freezeNo : 0;
    const out = orig(...a);
    safe(() => {
      if (had) {
        const why = String(a[0] ?? "");
        track("freeze_fail", { mode: modeOf(R), round_no: R.roundNo, photo_id: pid(R), grid: R.N,
          data: { n, why: why.startsWith('"') ? "wrong_answer" : why.slice(0, 60) } });
      }
    });
    return out;
  });

  const outcomeOf = (R) => {
    const d = R.done;
    return d ? (d.partial ? "partial" : "correct") : R.out ? "out" : R.endedEarly ? "gave_up" : "none";
  };
  const reportEnd = (R, outcome) => {
    if (!R || R._rep) return;
    R._rep = 1;
    const d = R.done;
    track("round_end", { mode: modeOf(R), round_no: R.roundNo, photo_id: pid(R), grid: R.N,
      data: { outcome, score: d ? d.score : 0, shown: d ? d.s : null, el: d ? d.el : null, freezes: R.freezesUsed,
        ms: Math.round(performance.now() - (R._t0 || 0)), hint: !!R.hint, scr: R.scr } });
    heartbeat(false); // play time is saved at every round end, so a lost close-time message costs at most one round
  };

  wrap("renderResults", (orig, a) => {
    const out = orig(...a);
    safe(() => { reportEnd(S.R, outcomeOf(S.R)); addRoundFeedback(S.R); });
    return out;
  });
  wrap("blitzNext", (orig, [score, label]) => {
    const R = S.R;
    safe(() => reportEnd(R, /half/i.test(label) ? "partial" : /correct/i.test(label) ? "correct" : /out/i.test(label) ? "out" : "none"));
    return orig(score, label);
  });
  wrap("blitzEnd", (orig, a) => {
    const B = S.blitz, R = S.R;
    safe(() => { if (R && R.done && R.partialOpen && !R.flash) reportEnd(R, "partial"); if (R) R._rep = 1; }); // run over: the open photo is not an abandon
    const out = orig(...a);
    safe(() => { track("blitz_end", { mode: "blitz", data: { total: B.total, photos: B.used.length } }); heartbeat(false); });
    safe(addRunFeedback);
    return out;
  });
  wrap("renderBlitzResults", (orig, a) => { const out = orig(...a); safe(addRunFeedback); return out; });
  wrap("renderHome", (orig, a) => { safe(() => abandonIfOpen("menu")); return orig(...a); });

  let lastScreen = "";
  wrap("render", (orig, a) => {
    const out = orig(...a);
    safe(() => { if (S.screen !== lastScreen) { lastScreen = S.screen; track("screen", { data: { name: S.screen } }); } });
    return out;
  });

  /* ---------- UI ---------- */
  const css = document.createElement("style");
  css.textContent = `
  .pt-fab{position:fixed;right:12px;bottom:12px;z-index:50;padding:10px 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);font:700 .9rem var(--body);cursor:pointer;box-shadow:0 4px 18px #0008}
  .pt-fab:focus-visible,.pt-sheet button:focus-visible,.pt-bar button:focus-visible{outline:2px solid var(--volt-hi);outline-offset:2px}
  .pt-bar{position:fixed;left:0;right:0;bottom:0;z-index:60;background:var(--panel);border-top:1px solid var(--line);padding:12px 14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;font:.85rem var(--body);color:var(--ink)}
  .pt-bar p{margin:0;flex:1 1 260px;color:var(--dim)} .pt-bar b{color:var(--ink)}
  .pt-sheet-bg{position:fixed;inset:0;z-index:70;background:#000a;display:flex;align-items:flex-end;justify-content:center}
  .pt-sheet{width:min(520px,100%);max-height:92vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px 16px 0 0;padding:16px;color:var(--ink);font:1rem var(--body)}
  .pt-sheet h3{margin:0 0 8px;font:900 1.2rem var(--display)} .pt-sheet label{display:block;margin:12px 0 4px;color:var(--dim);font-size:.85rem}
  .pt-sheet textarea,.pt-sheet input{width:100%;box-sizing:border-box;background:var(--night);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
  .pt-sheet textarea{min-height:64px;resize:vertical}
  .pt-row{display:flex;gap:6px;flex-wrap:wrap}
  .pt-chip,.pt-star,.pt-btn{background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:7px 12px;font:700 .85rem var(--body);cursor:pointer}
  .pt-chip[aria-pressed=true],.pt-star[aria-pressed=true]{background:#1450c8;border-color:var(--volt-hi)}
  .pt-btn.pri{background:linear-gradient(180deg,#2f8bff,#1450c8);border-color:#8cc8ff} .pt-note{font-size:.78rem;color:var(--dim);margin-top:8px}
  .pt-rf{margin:12px 0;text-align:center} .pt-rf .pt-row{justify-content:center} .pt-rf small{display:block;color:var(--dim);margin-top:6px}`;
  document.head.appendChild(css);

  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const post = (body) =>
    fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, ...body }) })
      .then((r) => r.ok);

  const ctx = () => {
    const R = S.R;
    return { screen: S.screen, mode: modeOf(R), round: R ? R.roundNo : null, photo: pid(R), grid: R ? R.N : null,
      viewport: innerWidth + "x" + innerHeight, build: BUILD, log: R && R.log ? R.log.slice(-20) : null };
  };

  const TAGS = [["fun", "Fun"], ["too_hard", "Too hard"], ["too_easy", "Too easy"], ["unfair_scoring", "Scoring felt unfair"],
    ["confusing", "Confusing"], ["too_slow", "Too slow"], ["photo_issue", "Photo problem"], ["answer_rejected", "My answer was rejected"],
    ["layout", "Layout / buttons"], ["performance", "Laggy"], ["other", "Other"]];

  function openFeedback() {
    if (document.querySelector(".pt-sheet-bg")) return;
    track("feedback_open", { data: { screen: S.screen } });
    const bg = el(`<div class="pt-sheet-bg"><div class="pt-sheet" role="dialog" aria-modal="true" aria-label="Send feedback">
      <h3>How is Glimpse Rush?</h3>
      <div class="pt-row" id="pt-stars" role="group" aria-label="Overall rating">${[1, 2, 3, 4, 5].map((n) => `<button class="pt-star" data-n="${n}" aria-pressed="false" aria-label="${n} of 5">${"★".repeat(n)}</button>`).join("")}</div>
      <label>What was it about? (tap any)</label>
      <div class="pt-row" id="pt-tags">${TAGS.map(([k, v]) => `<button class="pt-chip" data-k="${k}" aria-pressed="false">${v}</button>`).join("")}</div>
      <label for="pt-liked">What did you like?</label><textarea id="pt-liked" maxlength="1000"></textarea>
      <label for="pt-dis">What didn't you like?</label><textarea id="pt-dis" maxlength="1000"></textarea>
      <label for="pt-bug">Something broken? What happened?</label><textarea id="pt-bug" maxlength="1000"></textarea>
      <label for="pt-contact">Email (optional, only if you're OK with a follow-up)</label><input id="pt-contact" type="email" maxlength="120" autocomplete="email">
      <div class="pt-row" style="margin-top:14px"><button class="pt-btn pri" id="pt-send">Send</button><button class="pt-btn" id="pt-cancel">Cancel</button></div>
      <div class="pt-note" id="pt-msg">We attach which screen you were on and your last round's action log.</div></div></div>`);
    document.body.appendChild(bg);
    let rating = null; const tags = new Set();
    const close = () => bg.remove();
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    bg.querySelector("#pt-cancel").onclick = close;
    bg.querySelectorAll(".pt-star").forEach((b) => (b.onclick = () => {
      rating = +b.dataset.n; bg.querySelectorAll(".pt-star").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.n <= rating)));
    }));
    bg.querySelectorAll(".pt-chip").forEach((b) => (b.onclick = () => {
      const k = b.dataset.k; tags.has(k) ? tags.delete(k) : tags.add(k); b.setAttribute("aria-pressed", String(tags.has(k)));
    }));
    bg.querySelector("#pt-send").onclick = async () => {
      const v = (id) => bg.querySelector(id).value.trim();
      const body = { kind: "general", rating, tags: [...tags], liked: v("#pt-liked"), disliked: v("#pt-dis"), bug: v("#pt-bug"), contact: v("#pt-contact"), context: ctx() };
      const msg = bg.querySelector("#pt-msg");
      if (!rating && !tags.size && !body.liked && !body.disliked && !body.bug) { msg.textContent = "Add a rating, a tag or a few words first."; return; }
      msg.textContent = "Sending…";
      let ok = false; try { ok = await post(body); } catch { /* offline */ }
      if (ok) { msg.textContent = "Thank you! That helps."; setTimeout(close, 900); } else msg.textContent = "Couldn't send. Check your connection and try again.";
    };
    bg.querySelector("#pt-liked").focus();
  }

  const fabWrap = el(`<aside aria-label="Feedback"><button class="pt-fab" aria-label="Send feedback">Feedback</button></aside>`);
  const fab = fabWrap.firstElementChild;
  fab.onclick = openFeedback;
  document.body.appendChild(fabWrap);

  /* per-round reaction + "my answer should have counted" */
  function reactionCard(photoId, wrong) {
    const card = el(`<div class="pt-rf card"><b>How was that round?</b>
      <div class="pt-row" style="margin-top:8px"><button class="pt-btn" data-r="1" aria-label="Good round">👍 Good</button><button class="pt-btn" data-r="0" aria-label="Bad round">👎 Not good</button></div>
      ${wrong.length ? `<small>Was a wrong answer actually right?</small><div class="pt-row" style="margin-top:6px">${wrong.map((w, i) => `<button class="pt-chip" data-d="${i}">"${esc(w)}" should count</button>`).join("")}</div>` : ""}
      <small id="pt-st"></small></div>`);
    const st = card.querySelector("#pt-st");
    card.querySelectorAll("[data-r]").forEach((b) => (b.onclick = async () => {
      card.querySelectorAll("[data-r]").forEach((x) => (x.disabled = true));
      let ok = false; try { ok = await post({ kind: "round", rating: +b.dataset.r, photo_id: photoId, context: ctx() }); } catch { /* offline */ }
      st.textContent = ok ? "Thanks!" : "Couldn't send.";
      if (!ok) card.querySelectorAll("[data-r]").forEach((x) => (x.disabled = false));
    }));
    card.querySelectorAll("[data-d]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      let ok = false; try { ok = await post({ kind: "dispute", answer: wrong[+b.dataset.d], photo_id: photoId, context: ctx() }); } catch { /* offline */ }
      b.textContent = ok ? "Sent, thanks" : "Couldn't send";
      if (!ok) b.disabled = false;
    }));
    return card;
  }
  function addRoundFeedback(R) {
    const root = document.getElementById("app") || document.body;
    if (!R || root.querySelector(".pt-rf")) return;
    const anchor = root.querySelector("#home");
    const card = reactionCard(pid(R) || "unknown", (R._wrong || []).filter((w, i, a) => w && a.indexOf(w) === i).slice(0, 4));
    anchor ? anchor.before(card) : root.appendChild(card);
  }
  function addRunFeedback() {
    const root = document.getElementById("app") || document.body;
    if (root.querySelector(".pt-rf")) return;
    const card = reactionCard("blitz-run", []);
    const anchor = root.querySelector("#home");
    anchor ? anchor.before(card) : root.appendChild(card);
  }

  /* consent notice (feedback itself is always available; it is an explicit action) */
  function consentBar() {
    if (consent) return;
    const bar = el(`<div class="pt-bar" role="region" aria-label="Playtest notice">
      <p><b>Playtest build.</b> With your OK we record how you play: taps, timing, scores and the answers you type, under a random ID. No account, no IP address stored. Used only to improve this game.</p>
      <button class="pt-btn pri" id="pt-yes">Share anonymously</button><button class="pt-btn" id="pt-no">No thanks</button></div>`);
    const decide = (v) => {
      consent = v; ls.set("consent", v); if (v === "yes") { ls.set("sid", sid); startSession(); }
      bar.remove();
    };
    bar.querySelector("#pt-yes").onclick = () => decide("yes");
    bar.querySelector("#pt-no").onclick = () => decide("no");
    document.body.appendChild(bar);
  }

  function startSession() {
    track("session_start", { data: { ref: document.referrer ? new URL(document.referrer).hostname : null, visit, ...platform(), page: pageTiming() } });
    track("screen", { data: { name: S.screen } });
    flush(false);
  }

  if (consent === "yes") startSession();
  consentBar();
  window.__playtest = { track, flush, get sid() { return sid; }, get consent() { return consent; } };
})();
