//
// test.mjs — 純ロジック部のテスト (node test/test.mjs で実行)。
// Swift 版 Tests/EarTests の主要ケースを移植し、移植の忠実度を検証する。
//

import { strict as assert } from "node:assert";
import { SeededRNG, deterministicSeed, generate, romaji, katakana,
         mirroredKana } from "../js/core.js";
import { SoundEventAnalyzer } from "../js/analyzer.js";
import { mapAxes, pitchOffsets } from "../js/mapper.js";
import { shape, applyShape } from "../js/shaper.js";
import { renderEvent, attackGain } from "../js/renderer.js";
import { snapToEqualTemperament, noteDisplay, melodyDisplay } from "../js/notes.js";
import { deriveEffects, applyEffects } from "../js/effects.js";
import { matchPercussion } from "../js/percussion.js";
import { katakana as kata } from "../js/core.js";

const SR = 48000;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

// ─── 信号合成ヘルパ ───
const silence = (sec) => new Float32Array(Math.floor(sec * SR));
function sine(sec, hz, amp) {
  const n = Math.floor(sec * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * i / SR);
  return out;
}
function chirp(sec, f0, f1, amp) {
  const n = Math.floor(sec * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 + (f1 - f0) * (i / n);
    phase += 2 * Math.PI * f / SR;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}
function noise(sec, amp, seed = 1n) {
  const rng = new SeededRNG(seed);
  const n = Math.floor(sec * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (rng.nextDouble() * 2 - 1);
  return out;
}
function swell(riseSec, fallSec, hz, amp, floor = 0.005) {
  const riseN = Math.floor(riseSec * SR), fallN = Math.floor(fallSec * SR);
  const out = new Float32Array(riseN + fallN);
  for (let i = 0; i < out.length; i++) {
    const env = i < riseN
      ? floor + (amp - floor) * i / riseN
      : floor + (amp - floor) * (out.length - i) / fallN;
    out[i] = env * Math.sin(2 * Math.PI * hz * i / SR);
  }
  return out;
}
function concat(...arrs) {
  const total = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
/// 信号を analyzer に流し、確定したイベント列を返す。
function run(signal) {
  const an = new SoundEventAnalyzer(SR, 1024);
  const padded = concat(signal, silence(0.8));
  const events = [];
  for (let i = 0; i + 1024 <= padded.length; i += 1024) {
    const ev = an.process(padded.subarray(i, i + 1024));
    if (ev) events.push(ev);
  }
  return events;
}
/// テスト用の素の特徴。
function feat(over = {}) {
  return { durationSec: 0.3, peakDb: -20, meanDb: -26, attackSec: 0.02,
           releaseSec: 0.1, centroidHz: 1500, flatness: 0.3, zcr: 0.1,
           voicedRatio: 0, pitchMedianHz: 0, pitchSlopeSemisPerSec: 0,
           reattackCount: 1, envRoughnessDb: 1, spectralFlux: 0.05,
           pitchContourSemis: [], isSwellValleySwell: false, ...over };
}

console.log("core (generator/kana):");
test("決定性: 同じ軸は同じ語 (Swift パリティ既知値)", () => {
  // /tmp/parity (swiftc) で得た Swift 版の出力と一致すること
  const expect = [
    [[0.5, 0.5, 0.7, 0.5], "soboQsoboN"],
    [[-0.8, -0.6, -0.4, -0.2], "nooyamu"],
    [[0, 0, 0, 0], "naharazuN"],
    [[1, 1, 1, 1], "kyasaQkyasa"],
    [[-1, 0.3, 0.9, -0.7], "tajaQtaja"],
    [[0.25, -0.45, 0.15, 0.85], "repesere"],
  ];
  for (const [[size, sharpness, texture, brightness], word] of expect) {
    const axes = { size, sharpness, texture, brightness };
    const rng = new SeededRNG(deterministicSeed(axes));
    const ev = generate(axes, { temperature: 0.35, allowNilOnset: true,
                                allowMoraicN: true, moraCountOverride: 4, rng });
    assert.equal(romaji(ev), word);
  }
});
test("moraCountOverride が反映される", () => {
  const axes = { size: 0, sharpness: 0, texture: 0, brightness: 0 };
  for (const n of [1, 3, 6]) {
    const rng = new SeededRNG(1n);
    const ev = generate(axes, { moraCountOverride: n, rng });
    assert.equal(ev.moras.filter((m) => !m.isMoraicN).length, n);
  }
});
test("カタカナ表記 + 鏡像表記", () => {
  const moras = [
    { onset: "p", nucleus: "o", durationMs: 150, geminateGapMs: 0,
      voicing: 0, amplitude: 1, isMoraicN: false, pitchOffsetSemis: 0 },
    { onset: "w", nucleus: "a", durationMs: 150, geminateGapMs: 0,
      voicing: 1, amplitude: 1, isMoraicN: false, pitchOffsetSemis: 0 },
    { onset: null, nucleus: "a", durationMs: 160, geminateGapMs: 0,
      voicing: 1, amplitude: 1, isMoraicN: true, pitchOffsetSemis: 0 },
  ];
  assert.equal(katakana(moras, true), "ポワーン");
  assert.equal(mirroredKana("ポワーン"), "ポワーン ⇄ ンーワポ");
});

console.log("analyzer:");
test("無音はイベントを生まない", () => {
  assert.equal(run(silence(1.0)).length, 0);
});
test("正弦波 → 有声イベント、pitch ≈ 220Hz", () => {
  const evs = run(sine(0.6, 220, 0.3));
  assert.equal(evs.length, 1);
  const ev = evs[0];
  assert.ok(Math.abs(ev.durationSec - 0.6) < 0.1, `dur=${ev.durationSec}`);
  assert.ok(ev.voicedRatio > 0.8, `voiced=${ev.voicedRatio}`);
  assert.ok(Math.abs(ev.pitchMedianHz - 220) < 10, `pitch=${ev.pitchMedianHz}`);
});
test("ノイズバースト → 無声・高平坦度", () => {
  const ev = run(noise(0.15, 0.4))[0];
  assert.ok(ev.flatness > 0.2, `flatness=${ev.flatness}`);
  assert.ok(ev.voicedRatio < 0.3, `voiced=${ev.voicedRatio}`);
});
test("2 連打 → reattack 2 / 鏡像フラグなし", () => {
  const sig = concat(noise(0.08, 0.4), silence(0.25), noise(0.08, 0.4, 7n));
  const ev = run(sig)[0];
  assert.ok(ev.reattackCount >= 2, `reattacks=${ev.reattackCount}`);
  assert.equal(ev.isSwellValleySwell, false);
});
test("上昇チャープ → 正の傾き + 輪郭", () => {
  const ev = run(chirp(0.6, 200, 500, 0.3))[0];
  assert.ok(ev.pitchSlopeSemisPerSec > 5, `slope=${ev.pitchSlopeSemisPerSec}`);
});
test("上がって下がる旋律 → 山なりの輪郭", () => {
  const ev = run(concat(chirp(0.35, 220, 440, 0.3), chirp(0.35, 440, 220, 0.3)))[0];
  const c = ev.pitchContourSemis;
  assert.ok(c.length >= 2, "contour empty");
  const mid = c[Math.floor(c.length / 2)];
  assert.ok(mid > c[0] + 2 && mid > c[c.length - 1] + 2, `contour=${c.map((x) => x.toFixed(1))}`);
});
test("スウェル→谷→スウェル → 鏡像フラグ / 単発スウェルは false", () => {
  const two = concat(swell(0.3, 0.25, 220, 0.3), swell(0.3, 0.25, 220, 0.3));
  assert.equal(run(two)[0].isSwellValleySwell, true);
  assert.equal(run(swell(0.35, 0.3, 220, 0.3))[0].isSwellValleySwell, false);
});
test("チャープは定常音より flux が高い", () => {
  const steady = run(sine(0.6, 300, 0.3))[0];
  const moving = run(chirp(0.6, 200, 500, 0.3))[0];
  assert.ok(moving.spectralFlux > steady.spectralFlux);
});

console.log("打楽器の代表語化:");
test("シンバル: 明るく長い余韻のノイズ → シャ を含む", () => {
  const n = Math.floor(0.9 * SR);
  const sig = new Float32Array(n + Math.floor(0.8 * SR));
  const ns = noise(0.9, 0.5);
  for (let i = 0; i < n; i++) sig[i] = ns[i] * (1 - i / n);
  const an = new SoundEventAnalyzer(SR, 1024);
  let ev = null;
  for (let i = 0; i + 1024 <= sig.length; i += 1024) { const e = an.process(sig.subarray(i, i+1024)); if (e) ev = e; }
  const hit = matchPercussion(ev);
  assert.ok(hit && ["cymbal", "sizzle"].includes(hit.kind), `kind=${hit && hit.kind}`);
  const k = hit.kanaOverride ?? kata(hit.moras, hit.elongateFinal);
  assert.ok(k.includes("シャ"), `kana=${k}`);
  assert.ok(hit.elongateFinal);
});
test("ハイハット: 明るく極短のノイズ → チッ", () => {
  const ev = run(noise(0.04, 0.5))[0];
  const hit = matchPercussion(ev);
  assert.ok(hit && hit.kind === "hihat", `kind=${hit && hit.kind}`);
  assert.equal(hit.kanaOverride, "チッ");
});
test("キック: 低い短音 → ド を含む", () => {
  const ev = run(sine(0.18, 70, 0.4))[0];
  const hit = matchPercussion(ev);
  assert.ok(hit && ["kick", "bigKick"].includes(hit.kind), `kind=${hit && hit.kind}`);
  assert.ok(kata(hit.moras, hit.elongateFinal).startsWith("ド"));
});
test("持続音程 (声) → 打楽器にしない (null)", () => {
  const ev = run(sine(0.6, 220, 0.3))[0];
  assert.equal(matchPercussion(ev), null);
});

console.log("MacTuner 連携 (YIN + ドレミ):");
test("YIN: 60Hz の低音 (旧検出域 95Hz 未満) を聴き取れる", () => {
  const ev = run(sine(1.0, 60, 0.3))[0];
  assert.ok(ev.pitchMedianHz > 55 && ev.pitchMedianHz < 66, `pitch=${ev.pitchMedianHz}`);
  assert.ok(ev.voicedRatio > 0.5);
});
test("YIN: 1.5kHz の高音 (旧上限 800Hz 超え)", () => {
  const ev = run(sine(0.5, 1500, 0.3))[0];
  assert.ok(Math.abs(ev.pitchMedianHz - 1500) < 60, `pitch=${ev.pitchMedianHz}`);
});
test("baseF0 は平均律スナップ (225Hz → ラ3 220Hz)", () => {
  const s = shape(feat({ voicedRatio: 0.8, pitchMedianHz: 225 }), 0);
  assert.ok(Math.abs(s.baseF0Override - 220) < 0.5, `f0=${s.baseF0Override}`);
});
test("mora オフセットは整数半音 (ソルフェージュ模倣)", () => {
  const o = pitchOffsets([-2.4, 0.6, 1.3], 0, 0.5, 3);
  assert.ok(o.length > 0);
  for (const v of o) assert.equal(v, Math.round(v));
});
test("NoteNamer: 表示と旋律", () => {
  assert.equal(noteDisplay(440), "ラ4");
  assert.equal(noteDisplay(261.63), "ド4");
  assert.ok(noteDisplay(450).includes("+39"), noteDisplay(450));
  assert.ok(Math.abs(snapToEqualTemperament(225) - 220) < 0.01);
  assert.equal(melodyDisplay(392, [0, -3, 0]), "♪ソ・ミ・ソ");
  assert.equal(melodyDisplay(392, []), "♪ソ");
});

console.log("音質まねエフェクト:");
test("derive: 音色を写像 (明暗→トーン / 粗→crush / 動→wah)", () => {
  assert.ok(deriveEffects(feat({ centroidHz: 5000 })).toneLowpassHz >
            deriveEffects(feat({ centroidHz: 500 })).toneLowpassHz);
  assert.ok(deriveEffects(feat({ flatness: 0.5, zcr: 0.3 })).crushBits < 15.5);
  const tonal = deriveEffects(feat({ flatness: 0.05, zcr: 0.02 }));
  assert.equal(tonal.crushBits, 16);
  assert.equal(tonal.crushDownsample, 1);
  assert.ok(deriveEffects(feat({ spectralFlux: 0.5 })).wahDepth > 0);
  assert.equal(deriveEffects(feat({ spectralFlux: 0.05 })).wahDepth, 0);
});
test("apply: 範囲内 + 波形変化 / bypass は無変更 / S&H ホールド", () => {
  const sig = sine(0.3, 440, 0.5);
  const orig = Float32Array.from(sig);
  applyEffects(deriveEffects(feat({ centroidHz: 600, flatness: 0.5, zcr: 0.3, spectralFlux: 0.5 })),
               sig, 48000);
  assert.equal(sig.length, orig.length);
  assert.ok(sig.every((v) => Math.abs(v) <= 1.0001));
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff = Math.max(diff, Math.abs(sig[i] - orig[i]));
  assert.ok(diff > 0.01, "エフェクトで波形が変化");

  const sig2 = sine(0.2, 440, 0.5);
  const orig2 = Float32Array.from(sig2);
  applyEffects({ enabled: false }, sig2, 48000);
  assert.deepEqual(sig2, orig2);

  const sh = new Float32Array(32).map((_, i) => i / 32);
  applyEffects({ enabled: true, toneLowpassHz: 9000, toneHighpassHz: 0, wahDepth: 0,
                 drive: 0, crushBits: 16, crushDownsample: 4 }, sh, 48000);
  for (let b = 0; b < 28; b += 4) {
    for (let k = 1; k < 4; k++) assert.ok(Math.abs(sh[b + k] - sh[b]) < 1e-6);
  }
});

console.log("mapper:");
test("軸は常に [-1, 1]", () => {
  const extremes = [
    feat({ durationSec: 0.01, peakDb: -5, attackSec: 0.001, centroidHz: 12000,
           flatness: 1, zcr: 0.9, pitchSlopeSemisPerSec: 99, reattackCount: 50,
           envRoughnessDb: 30, spectralFlux: 1 }),
    feat({ durationSec: 10, peakDb: -60, attackSec: 5, releaseSec: 9,
           centroidHz: 0, flatness: 0, zcr: 0, voicedRatio: 1,
           pitchMedianHz: 60, pitchSlopeSemisPerSec: -99, reattackCount: 0,
           envRoughnessDb: 0 }),
  ];
  for (const f of extremes) {
    const a = mapAxes(f);
    for (const k of ["size", "sharpness", "texture", "brightness"]) {
      assert.ok(a[k] >= -1 && a[k] <= 1, `${k}=${a[k]}`);
    }
  }
});
test("輪郭 → mora オフセット (clamp ±6 / フォールバック)", () => {
  const o = pitchOffsets([-3, 0, 3], 0, 0.5, 3);
  assert.deepEqual(o.map((x) => Math.round(x)), [-3, 0, 3]);
  assert.deepEqual(pitchOffsets([-20, 20], 0, 0.5, 2), [-6, 6]);
  assert.equal(pitchOffsets([0.1, -0.1], 0, 0.5, 3).length, 0);
  const ramp = pitchOffsets([], 20, 0.5, 3);
  assert.ok(ramp[0] < ramp[2]);
});

console.log("shaper:");
test("アタック鏡映し (打撃=即 / swell=同長 / 上限 0.9s)", () => {
  assert.equal(shape(feat({ attackSec: 0.02 }), 0).attackSec, 0);
  assert.ok(Math.abs(shape(feat({ durationSec: 1, attackSec: 0.4 }), 0).attackSec - 0.4) < 1e-9);
  assert.ok(Math.abs(shape(feat({ durationSec: 2, attackSec: 1.8 }), 0).attackSec - 0.9) < 1e-9);
});
test("鏡像入力は語が半分 + フラグ", () => {
  const plain = shape(feat({ durationSec: 1.6 }), 0);
  const mirror = shape(feat({ durationSec: 1.6, isSwellValleySwell: true }), 0);
  assert.equal(mirror.mirrorReverse, true);
  assert.ok(mirror.moraCount < plain.moraCount);
});
test("速い変化 → 細かく速い刻み", () => {
  const calm = shape(feat({ durationSec: 0.75 }), 0);
  const rapid = shape(feat({ durationSec: 0.75, reattackCount: 6 }), 0);
  assert.ok(rapid.changeSpeed > calm.changeSpeed);
  assert.ok(rapid.moraDurationMs < calm.moraDurationMs);
});
test("音量呼応: 大きい音には大きく", () => {
  assert.ok(shape(feat({ peakDb: -10 }), 0).replyGain >
            shape(feat({ peakDb: -40 }), 0).replyGain);
});

console.log("renderer:");
test("attackGain: x² 曲線 0→1 単調", () => {
  assert.equal(attackGain(0, 100), 0);
  assert.equal(attackGain(100, 100), 1);
  assert.ok(Math.abs(attackGain(50, 100) - 0.25) < 1e-9);
  assert.equal(attackGain(0, 0), 1);
});
test("render: 合成長 ≈ 語長 + release / 鏡像で約 2 倍 / clip 内", () => {
  // ダミーサンプル (200ms の減衰正弦)
  const dummy = (() => {
    const n = Math.floor(0.2 * SR);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = 0.8 * Math.sin(2 * Math.PI * 220 * i / SR) * (1 - i / n);
    }
    return a;
  })();
  const samples = { cv_ka: dummy, cv_ra: dummy };
  const moras = [
    { onset: "k", nucleus: "a", durationMs: 150, geminateGapMs: 0,
      voicing: 0, amplitude: 1, isMoraicN: false, pitchOffsetSemis: 0 },
    { onset: "r", nucleus: "a", durationMs: 150, geminateGapMs: 0,
      voicing: 1, amplitude: 1, isMoraicN: false, pitchOffsetSemis: 2 },
  ];
  const event = { axes: null, moras, baseF0: 200, isReduplicated: false };
  const r = renderEvent(event, samples, SR);
  assert.ok(Math.abs(r.durationSec - 0.65) < 0.02, `dur=${r.durationSec}`);
  let peak = 0;
  for (const v of r.data) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.1 && peak <= 1.0, `peak=${peak}`);
  const m = renderEvent(event, samples, SR, { mirrorReverse: true });
  assert.ok(m.durationSec > r.durationSec * 1.8 && m.durationSec < r.durationSec * 2.4);
  // attack エンベロープで頭が静かになる
  const att = renderEvent(event, samples, SR, { attackSec: 0.3 });
  let head = 0, headPlain = 0;
  for (let i = 0; i < Math.floor(0.05 * SR); i++) {
    head = Math.max(head, Math.abs(att.data[i]));
    headPlain = Math.max(headPlain, Math.abs(r.data[i]));
  }
  assert.ok(head < headPlain * 0.2, `head=${head} plain=${headPlain}`);
});
test("shape 適用で mora 長が上書きされる (撥音は除く)", () => {
  const event = {
    axes: null, baseF0: 200, isReduplicated: false,
    moras: [
      { onset: "g", nucleus: "o", durationMs: 170, geminateGapMs: 0,
        voicing: 1, amplitude: 1, isMoraicN: false, pitchOffsetSemis: 0 },
      { onset: null, nucleus: "a", durationMs: 160, geminateGapMs: 0,
        voicing: 1, amplitude: 1, isMoraicN: true, pitchOffsetSemis: 0 },
    ],
  };
  const sh = { moraCount: 1, moraDurationMs: 300, elongateFinal: false,
               baseF0Override: 250, replyGain: 1, changeSpeed: 0,
               attackSec: 0, mirrorReverse: false };
  const out = applyShape(sh, event);
  assert.equal(out.moras[0].durationMs, 300);
  assert.equal(out.moras[1].durationMs, 160);
  assert.equal(out.baseF0, 250);
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with FAILURES)" : ""}`);
