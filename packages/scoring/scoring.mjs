// Glimpse Rush — reference scoring library (Spec v1.1, Sections 4–5)
// Pure integer arithmetic. No floats in the scoring path. All values < 2^53.

export const GAME = Object.freeze({
  REVEAL_MS: 30000, FINAL_WINDOW_MS: 10000,
  GRID_MULT_100: Object.freeze({ 4: 50, 9: 75, 16: 90, 25: 100, 36: 150, 64: 200, 100: 300 }),
  FINAL_WINDOW_FLAT: 50,
});

const assertInt = (v, name) => {
  if (!Number.isSafeInteger(v)) throw new TypeError(`${name} must be a safe integer, got ${v}`);
};

function gridMult100(N) {
  assertInt(N, 'N');
  const g = GAME.GRID_MULT_100[N];
  if (g === undefined) throw new RangeError(`unsupported grid N=${N}`);
  return g;
}

/** Section 4: tiles visible at elapsed_ms since reveal_start. */
export function tilesShown(N, elapsedMs) {
  gridMult100(N); assertInt(elapsedMs, 'elapsedMs');
  if (elapsedMs < 0) throw new RangeError('elapsedMs < 0 (freeze before reveal_start)');
  return Math.min(N, Math.floor((elapsedMs * N) / GAME.REVEAL_MS) + 1);
}

/** Integer half-up division for non-negative num, positive den. */
function divHalfUp(num, den) {
  if (num < 0 || den <= 0) throw new RangeError('divHalfUp domain');
  return Math.floor((2 * num + den) / (2 * den));
}

const SCRAMBLE_MULT_4 = [4, 5, 6]; // Spec §4a: ×1.0 / ×1.25 / ×1.5

function multipliers({ freezeNo = 1, partial = false, hint = false, scramble = 0 }) {
  if (freezeNo !== 1 && freezeNo !== 2) throw new RangeError(`freezeNo must be 1 or 2, got ${freezeNo}`);
  if (![0, 1, 2].includes(scramble)) throw new RangeError(`scramble must be 0, 1 or 2, got ${scramble}`);
  const P4 = freezeNo === 1 ? 4 : 3;
  const M = (partial ? 2 : 1) * (hint ? 2 : 1);
  return { P4, M, S4: SCRAMBLE_MULT_4[scramble] };
}

/** Section 5.4: flat score for a correct answer from a FINAL_WINDOW freeze. */
export function finalWindowScore(N, opts = {}) {
  const g = gridMult100(N);
  const { P4, M, S4 } = multipliers(opts);
  // 50 × (g/100) × (P4/4) × (S4/4) / M
  return divHalfUp(GAME.FINAL_WINDOW_FLAT * g * P4 * S4, 100 * 4 * 4 * M);
}

/** Section 5.1 + 5.4a: score for a correct answer from a REVEAL freeze. */
export function revealScore(N, elapsedMs, opts = {}) {
  const g = gridMult100(N);
  if (elapsedMs >= GAME.REVEAL_MS) throw new RangeError('elapsedMs outside REVEAL; use scoreFreeze');
  const s = tilesShown(N, elapsedMs);
  const timeLeft = Math.max(0, GAME.REVEAL_MS - elapsedMs);
  const { P4, M, S4 } = multipliers(opts);
  const num = g * (N - s) * (30000 + 3 * timeLeft) * P4 * S4;
  const formula = divHalfUp(num, 96000 * N * M);
  return Math.max(formula, finalWindowScore(N, opts));
}

/** Dispatcher by elapsed since reveal_start. Throws outside REVEAL/FINAL_WINDOW (Section 8 score bounds). */
export function scoreFreeze(N, elapsedMs, opts = {}) {
  assertInt(elapsedMs, 'elapsedMs');
  if (elapsedMs < 0) throw new RangeError('freeze before reveal_start');
  if (elapsedMs < GAME.REVEAL_MS) return revealScore(N, elapsedMs, opts);
  if (elapsedMs < GAME.REVEAL_MS + GAME.FINAL_WINDOW_MS) return finalWindowScore(N, opts);
  throw new RangeError('freeze after FINAL_WINDOW');
}

/** Section 5.6 validation bound (× scramble S). */
export function maxScore(N, scramble = 0) {
  const g = gridMult100(N);
  const { S4 } = multipliers({ scramble });
  return divHalfUp(1000 * g * (N - 1) * 2 * S4, 100 * N * 4);
}
