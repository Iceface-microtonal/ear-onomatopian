//
// effects.js — EarEffects の JS 移植 (音質まね, 2026-06-13)。
// 解析特徴 → エフェクト設定を導き、レンダリング済み Float32Array に後段 DSP を掛ける。
//   重心 → トーン (LP/HP) / 流量+輪郭 → ワウ (共振 BP 掃引) /
//   平坦度+ZCR → ビットクラッシャ / 音量+高域 → ドライブ
// Swift 版 Ear/EarEffects(+Derive).swift と 1:1。
//

const clampD = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const unit = (x, lo, hi) => (hi > lo ? Math.max(0, Math.min(1, (x - lo) / (hi - lo))) : 0);

/// 特徴 → エフェクト設定。
export function deriveEffects(f) {
  const s = {
    enabled: true,
    toneLowpassHz: 9000, toneHighpassHz: 0,
    wahCenterHz: 1200, wahQ: 4, wahDepth: 0, wahSweepSemis: [], wahLfoHz: 4,
    drive: 0, crushBits: 16, crushDownsample: 1,
  };
  const centroid = f.centroidHz;
  s.toneLowpassHz = clampD(centroid > 0 ? centroid * 1.5 : 9000, 700, 9000);
  s.toneHighpassHz = (centroid > 3000 && f.flatness > 0.25)
    ? clampD(centroid * 0.45, 300, 2500) : 0;

  s.wahDepth = unit(f.spectralFlux, 0.18, 0.55);
  s.wahCenterHz = clampD(centroid > 0 ? centroid : 1200, 350, 2600);
  s.wahQ = 4 + 4 * s.wahDepth;
  s.wahSweepSemis = (f.voicedRatio > 0.4 && f.pitchContourSemis.length >= 2)
    ? f.pitchContourSemis : [];
  s.wahLfoHz = 3 + 7 * unit(Math.max(0, f.reattackCount - 1), 0, 4);

  const harsh = Math.max(unit(f.flatness, 0.12, 0.55), unit(f.zcr, 0.06, 0.35));
  if (harsh > 0.1) {
    s.crushBits = 16 - harsh * 11;
    s.crushDownsample = harsh > 0.25 ? 1 + Math.round(harsh * 5) : 1;
  }

  s.drive = Math.max(0, 0.5 * unit(f.peakDb, -16, -3) + 0.5 * unit(f.zcr, 0.10, 0.40) - 0.1);
  return s;
}

/// ワウ中心の上下 (オクターブ)。輪郭があればなぞり、無ければ三角 LFO。
function sweepOctave(s, pos) {
  if (s.wahSweepSemis.length >= 2) {
    const c = s.wahSweepSemis;
    const p = pos * (c.length - 1);
    const j = Math.min(c.length - 2, Math.floor(p));
    const u = p - j;
    const semis = c[j] * (1 - u) + c[j + 1] * u;
    return (semis / 12) * 1.5;
  }
  const phase = (pos * s.wahLfoHz) % 1;
  const tri = Math.abs(phase * 4 - 2) - 1;
  return tri * 0.7 * s.wahDepth;
}

/// 設定を Float32Array に適用 (in place)。トーン → ワウ → ドライブ → クラッシュ。
export function applyEffects(s, samples, sampleRate) {
  if (!s || !s.enabled || samples.length === 0 || sampleRate <= 0) return;
  const n = samples.length;

  // 1) トーン: 1-pole ローパス → (任意) ハイパス
  if (s.toneLowpassHz < 8800) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * Math.max(1, s.toneLowpassHz));
    const a = dt / (rc + dt);
    let y = 0;
    for (let i = 0; i < n; i++) { y += a * (samples[i] - y); samples[i] = y; }
  }
  if (s.toneHighpassHz > 0) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * Math.max(1, s.toneHighpassHz));
    const a = rc / (rc + dt);
    let yPrev = 0, xPrev = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i];
      const y = a * (yPrev + x - xPrev);
      yPrev = y; xPrev = x; samples[i] = y;
    }
  }

  // 2) ワウ: 中心を掃引する共振バンドパス (TPT SVF)
  if (s.wahDepth > 0.02) {
    const k = 1 / Math.max(0.5, s.wahQ);
    let ic1 = 0, ic2 = 0;
    const mix = Math.min(0.9, s.wahDepth * 0.85);
    for (let i = 0; i < n; i++) {
      const pos = n > 1 ? i / (n - 1) : 0;
      const oct = sweepOctave(s, pos);
      const fc = clampD(s.wahCenterHz * Math.pow(2, oct), 120, 7000);
      const g = Math.tan(Math.PI * fc / sampleRate);
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const x = samples[i];
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      const bp = v1;
      samples[i] = x * (1 - mix) + bp * mix * 2;
    }
  }

  // 3) ドライブ: ソフトクリップ
  if (s.drive > 0.01) {
    const g = 1 + s.drive * 5;
    const norm = Math.tanh(g);
    for (let i = 0; i < n; i++) samples[i] = Math.tanh(samples[i] * g) / norm;
  }

  // 4) ビットクラッシャ: S&H 間引き → 量子化
  if (s.crushDownsample > 1) {
    let held = 0;
    for (let i = 0; i < n; i++) {
      if (i % s.crushDownsample === 0) held = samples[i];
      samples[i] = held;
    }
  }
  if (s.crushBits < 15.5) {
    const levels = Math.pow(2, Math.max(1, s.crushBits));
    for (let i = 0; i < n; i++) samples[i] = Math.round(samples[i] * levels) / levels;
  }

  for (let i = 0; i < n; i++) samples[i] = Math.max(-1, Math.min(1, samples[i]));
}
