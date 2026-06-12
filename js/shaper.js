//
// shaper.js — EarWordShaper の JS 移植。
// 「音の形 → 語の形」のものまね的な呼応 (長さ/ピッチ/声量/語尾/立ち上がり/鏡像)。
//

export const ELONGATION_FACTOR = 2.2;

export function shape(f, texture) {
  // 変化の速さ → 発話の刻み
  const pitchSpeed = Math.min(1, Math.abs(f.pitchSlopeSemisPerSec) / 24);
  const fluxSpeed = Math.max(0, Math.min(1, (f.spectralFlux - 0.15) / 0.35));
  const hitRate = f.durationSec > 0
    ? Math.min(1, Math.max(0, f.reattackCount - 1) / f.durationSec / 8)
    : 0;
  const changeSpeed = Math.max(pitchSpeed, fluxSpeed, hitRate);

  // 長さ → mora 数 (鏡像返しは順+逆で 2 回鳴るので半分に)
  const targetDur = Math.max(0.12, Math.min(2.2,
    f.durationSec * (f.isSwellValleySwell ? 0.5 : 1.0)));
  const baseMoraLen = texture >= 0 ? 0.15 : 0.15 + 0.12 * -texture;
  const moraLenSec = baseMoraLen / (1 + 0.8 * changeSpeed);
  const moraCount = Math.max(1, Math.min(6, Math.round(targetDur / moraLenSec)));

  const minMoraMs = 110 - 20 * changeSpeed;
  const moraDurationMs = Math.max(minMoraMs,
    Math.min(320, (targetDur / moraCount) * 1000));

  // 余韻 → 語尾伸ばし
  const elongateFinal = f.releaseSec > 0.35 && texture < 0.3 && moraCount <= 4;

  // ピッチ模倣 (オクターブを声域 140..340Hz に畳む)
  let baseF0Override = null;
  if (f.voicedRatio > 0.4 && f.pitchMedianHz > 0) {
    let hz = f.pitchMedianHz;
    while (hz > 340) hz /= 2;
    while (hz < 140) hz *= 2;
    baseF0Override = hz;
  }

  // 音量呼応
  const t = Math.max(0, Math.min(1, (f.peakDb + 45) / 35));
  const replyGain = 0.35 + 0.65 * t;

  // アタック鏡映し
  const attackSec = f.attackSec < 0.05 ? 0 : Math.min(0.9, f.attackSec);

  return { moraCount, moraDurationMs, elongateFinal, baseF0Override,
           replyGain, changeSpeed, attackSec,
           mirrorReverse: f.isSwellValleySwell };
}

/// 生成済み event へ語の形を適用 (mora 長・語尾伸ばし・baseF0)。
export function applyShape(sh, event) {
  const moras = event.moras.map((m) => ({ ...m }));
  let lastAudible = -1;
  for (let i = moras.length - 1; i >= 0; i--) {
    const m = moras[i];
    if (!(m.amplitude <= 0 && !m.isMoraicN)) { lastAudible = i; break; }
  }
  for (let i = 0; i < moras.length; i++) {
    const m = moras[i];
    if (m.amplitude <= 0 && !m.isMoraicN) continue; // silent rest
    if (m.isMoraicN) continue;                       // 撥音は録音準拠の長さ
    let d = sh.moraDurationMs;
    if (sh.elongateFinal && i === lastAudible) d *= ELONGATION_FACTOR;
    m.durationMs = d;
  }
  return { axes: event.axes, moras,
           baseF0: sh.baseF0Override ?? event.baseF0,
           isReduplicated: event.isReduplicated };
}
