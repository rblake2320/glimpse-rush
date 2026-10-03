// Run: node --test scoring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesShown, scoreFreeze, revealScore, finalWindowScore, maxScore, GAME } from './scoring.mjs';

// Suite A — spec vectors (Section 11). Proves the library matches the locked numbers.
const VECTORS = [
  ['TV01', 36, 0, 1, 1, 2917], ['TV02', 36, 7000, 1, 9, 1856], ['TV03', 36, 7083, 1, 9, 1852],
  ['TV04', 36, 7500, 1, 10, 1760], ['TV05', 36, 12400, 1, 15, 1208], ['TV06', 25, 0, 1, 1, 1920],
  ['TV07', 25, 10000, 1, 9, 960], ['TV08', 64, 5000, 1, 11, 2898], ['TV09', 100, 2950, 1, 10, 5002],
  ['TV10', 100, 15000, 1, 51, 1838], ['TV12', 36, 12400, 2, 15, 906],
  ['TV13', 36, 112, 1, 1, 2909], ['TV15', 36, 28000, 1, 34, 75], ['TV16', 36, 28000, 2, 34, 56],
];
for (const [id, N, el, fz, tiles, exp] of VECTORS) {
  test(`A ${id}`, () => {
    assert.equal(tilesShown(N, el), tiles);
    assert.equal(scoreFreeze(N, el, { freezeNo: fz }), exp);
  });
}
test('A TV11 floor replaces 0 with final-window flat', () => assert.equal(scoreFreeze(36, 29990), 75));
test('A TV14 partial rounds once', () => assert.equal(scoreFreeze(25, 21, { partial: true }), 959));
test('A aux asserts', () => {
  assert.equal(scoreFreeze(36, 30000), 75);
  assert.equal(scoreFreeze(100, 39999), 150);
  assert.equal(finalWindowScore(36, { freezeNo: 2 }), 56);
  assert.equal(finalWindowScore(36, { partial: true }), 38);
  assert.equal(scoreFreeze(36, 7000, { partial: true }), 928);
  assert.equal(scoreFreeze(36, 7000, { hint: true }), 928);
  assert.deepEqual([25, 36, 64, 100].map((n) => maxScore(n)), [1920, 2917, 3938, 5940]);
});

// Suite B — tile-boundary adversarial. Proves no off-by-one at flip instants.
test('B every tile flips exactly at ceil((k-1)·30000/N)', () => {
  for (const N of [4, 9, 16, 25, 36, 64, 100]) {
    for (let k = 2; k <= N; k++) {
      const t = Math.ceil(((k - 1) * GAME.REVEAL_MS) / N);
      assert.equal(tilesShown(N, t - 1), k - 1, `N=${N} k=${k} pre`);
      assert.equal(tilesShown(N, t), k, `N=${N} k=${k} at`);
    }
    assert.equal(tilesShown(N, 0), 1);
    assert.equal(tilesShown(N, 10 ** 7), N);
  }
});

// Suite C — exhaustive invariants over every ms of every grid/mode. Proves monotonicity, bounds, floor.
test('C invariants for all 4×30,000 REVEAL ms × 2 freezes × partial/hint', () => {
  for (const N of [25, 36, 64, 100]) {
    const max = maxScore(N);
    for (const freezeNo of [1, 2]) for (const partial of [false, true]) for (const hint of [false, true]) {
      const o = { freezeNo, partial, hint };
      const flat = finalWindowScore(N, o);
      let prev = Infinity;
      for (let el = 0; el < GAME.REVEAL_MS; el++) {
        const s = revealScore(N, el, o);
        assert.ok(Number.isSafeInteger(s));
        assert.ok(s <= max, `exceeds max N=${N} el=${el}`);
        assert.ok(s >= flat, `below floor N=${N} el=${el}`);
        assert.ok(s <= prev, `non-monotonic N=${N} el=${el}`);
        prev = s;
      }
    }
  }
});

// Suite D — rounding-mode traps. Proves half-up and single rounding (fails under banker's or double-round).
test('D half-up, not banker\'s', () => {
  assert.equal(scoreFreeze(36, 112), 2909);   // raw 2908.5
  assert.equal(scoreFreeze(36, 12400), 1208); // raw 1207.5
  assert.equal(scoreFreeze(64, 0), 3938);     // raw 3937.5
});
test('D second freeze never beats first; partial never beats full', () => {
  for (const N of [25, 36, 64, 100]) for (let el = 0; el < 30000; el += 37) {
    assert.ok(scoreFreeze(N, el, { freezeNo: 2 }) <= scoreFreeze(N, el));
    assert.ok(scoreFreeze(N, el, { partial: true }) <= scoreFreeze(N, el));
  }
});

// Suite E — hostile input. Proves bad server/client values throw instead of scoring.
test('E rejects out-of-window and malformed inputs', () => {
  const bad = [
    () => scoreFreeze(36, -1), () => scoreFreeze(36, 40000), () => scoreFreeze(36, 1e9),
    () => scoreFreeze(36, 1.5), () => scoreFreeze(36, NaN), () => scoreFreeze(36, Infinity),
    () => scoreFreeze(36, '7000'), () => scoreFreeze(49, 0), () => scoreFreeze(0, 0),
    () => scoreFreeze(36, 0, { freezeNo: 3 }), () => scoreFreeze(36, 0, { freezeNo: 0 }),
    () => revealScore(36, 30000), () => tilesShown(36, -5),
  ];
  for (const f of bad) assert.throws(f);
});

// Suite F — scramble levels (Spec §4a). Proves S multiplies formula, floor, and bound with one rounding.
test('F scramble vectors TV17–TV20', () => {
  assert.equal(scoreFreeze(36, 7000, { scramble: 1 }), 2320);
  assert.equal(scoreFreeze(36, 7000, { scramble: 2 }), 2784);
  assert.equal(scoreFreeze(36, 30000, { scramble: 2 }), 113);
  assert.equal(scoreFreeze(100, 0, { scramble: 2 }), 8910);
  assert.equal(maxScore(100, 2), 8910);
});
test('F scramble invariants: monotone in level, within bound, bad level rejected', () => {
  for (const N of [25, 36, 64, 100]) for (let el = 0; el < 40000; el += 53) {
    const a = scoreFreeze(N, el), b = scoreFreeze(N, el, { scramble: 1 }), c = scoreFreeze(N, el, { scramble: 2 });
    assert.ok(a <= b && b <= c, `N=${N} el=${el}`);
    assert.ok(c <= maxScore(N, 2));
  }
  for (const bad of [3, -1, 1.5, '1']) assert.throws(() => scoreFreeze(36, 0, { scramble: bad }));
});
