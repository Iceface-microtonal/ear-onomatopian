//
// renderer.js — MoraSamplePlayer.render の JS 移植 (純ロジック)。
// event + 録音 CV サンプル (Float32Array 辞書) → 1 本の composite Float32Array。
// 再生 (AudioBufferSourceNode) は app.js 側で行う。
//

import { totalDurationMs } from "./core.js";

/// mora → wav 名。撥音 = n_N、母音単独 = v_<v>、CV = cv_<c><v>。
export function sampleName(mora) {
  if (mora.isMoraicN) return "n_N";
  if (mora.onset) return `cv_${mora.onset}${mora.nucleus}`;
  return `v_${mora.nucleus}`;
}

/// 立ち上がりエンベロープ (x² swell)。
export function attackGain(frame, attackFrames) {
  if (attackFrames <= 0 || frame >= attackFrames) return 1;
  const x = frame / attackFrames;
  return x * x;
}

/// src を rate で線形補間リサンプルし、dst の atSec 位置へ加算ミックス。
function mixInto(src, dst, totalFrames, atSec, maxSec, rate, amplitude, sampleRate) {
  const srcLen = src.length;
  const start = Math.floor(atSec * sampleRate);
  const natural = Math.floor(srcLen / rate);
  const limit = Math.floor(maxSec * sampleRate);
  const outLen = Math.min(natural, limit, totalFrames - start);
  if (outLen <= 0) return;

  const truncated = natural > outLen;
  const fadeLen = truncated ? Math.min(Math.floor(0.025 * sampleRate), outLen >> 1) : 0;

  for (let t = 0; t < outLen; t++) {
    const pos = t * rate;
    const i0 = Math.floor(pos);
    if (i0 + 1 >= srcLen) break;
    const frac = pos - i0;
    let v = (src[i0] * (1 - frac) + src[i0 + 1] * frac) * amplitude;
    if (fadeLen > 0 && t >= outLen - fadeLen) {
      v *= (outLen - t) / fadeLen;
    }
    dst[start + t] += v;
  }
}

/// event → composite Float32Array。
/// - samples: { name → Float32Array } (context.sampleRate へデコード済み)
/// - 返値: { data: Float32Array, durationSec: number } または null
export function renderEvent(event, samples, sampleRate,
                            { gain = 1.0, attackSec = 0, mirrorReverse = false } = {}) {
  // baseF0 → グローバル半音 (録音 ≈ 200Hz 基準)。±6 半音。
  const globalSemis = Math.max(-6, Math.min(6, 12 * Math.log2(event.baseF0 / 200)));

  const tailSec = 0.08;
  const releaseSec = 0.35;
  const totalSec = totalDurationMs(event) / 1000 + releaseSec;
  const totalFrames = Math.floor(totalSec * sampleRate) + 1;
  const dst = new Float32Array(totalFrames);

  let cursorSec = 0;
  event.moras.forEach((mora, i) => {
    cursorSec += mora.geminateGapMs / 1000;
    const slotSec = mora.durationMs / 1000;
    const isSilent = mora.amplitude <= 0 && !mora.isMoraicN;
    if (!isSilent && mora.amplitude > 0) {
      const src = samples[sampleName(mora)];
      if (src) {
        const isLast = i === event.moras.length - 1;
        const maxSec = slotSec + (isLast ? releaseSec : tailSec);
        const rate = Math.pow(2, (globalSemis + mora.pitchOffsetSemis) / 12);
        mixInto(src, dst, totalFrames, cursorSec, maxSec, rate,
                mora.amplitude, sampleRate);
      }
    }
    cursorSec += slotSec;
  });

  // アタック鏡映し (語の 70% を上限)
  if (attackSec > 0) {
    const attackFrames = Math.min(Math.floor(attackSec * sampleRate),
                                  Math.floor(totalFrames * 0.7));
    for (let t = 0; t < attackFrames; t++) dst[t] *= attackGain(t, attackFrames);
  }

  // 鏡像 (順 + 60ms 谷 + 逆再生のパリンドローム)
  let out = dst;
  if (mirrorReverse) {
    const n = totalFrames;
    const gapFrames = Math.floor(0.06 * sampleRate);
    const big = new Float32Array(n * 2 + gapFrames);
    big.set(dst, 0);
    const back = n + gapFrames;
    for (let t = 0; t < n; t++) big[back + t] = dst[n - 1 - t];
    out = big;
  }

  // 音量呼応ゲイン → 安全クリップ
  for (let t = 0; t < out.length; t++) {
    out[t] = Math.max(-1, Math.min(1, out[t] * gain));
  }
  return { data: out, durationSec: out.length / sampleRate };
}
