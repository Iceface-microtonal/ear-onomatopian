//
// mapper.js — EarAxisMapper の JS 移植。
// SoundEventFeatures (音響特徴) → PhonosymbolicAxes (4 軸) の写像。
//

const clamp = (v) => Math.max(-1, Math.min(1, v));

const lin = (x, lo, hi) => {
  if (hi <= lo) return 0;
  return clamp(((x - lo) / (hi - lo)) * 2 - 1);
};

const logLin = (x, lo, hi) => {
  if (x <= 0) return -1;
  return lin(Math.log2(x), Math.log2(lo), Math.log2(hi));
};

// チューニング定数 (Swift 版と同値)
const sizeLoudW = 0.45, sizeDurW = 0.30, sizeLowW = 0.25;
const sharpAttackW = 0.55, sharpZcrW = 0.25, sharpShortW = 0.20;
const texReattackW = 0.50, texFlatW = 0.30, texRoughW = 0.20;
const brightCentroidW = 0.85, brightPitchW = 0.15;

export function mapAxes(f) {
  const centroidPos = logLin(f.centroidHz, 400, 4800);
  const pitchPos = f.pitchMedianHz > 0 ? logLin(f.pitchMedianHz, 120, 600) : 0;
  const brightness = clamp(brightCentroidW * centroidPos + brightPitchW * pitchPos);

  const loud = lin(f.peakDb, -42, -8);
  const dur = logLin(f.durationSec, 0.08, 1.6);
  let lowness;
  if (f.pitchMedianHz > 0 && f.voicedRatio > 0.3) {
    lowness = -logLin(f.pitchMedianHz, 100, 500);
  } else {
    lowness = -centroidPos;
  }
  const size = clamp(sizeLoudW * loud + sizeDurW * dur + sizeLowW * lowness);

  const attackFast = -logLin(f.attackSec, 0.02, 0.30);
  const hf = lin(f.zcr, 0.02, 0.30);
  const shortness = -logLin(f.durationSec, 0.06, 1.0);
  const sharpness = clamp(sharpAttackW * attackFast + sharpZcrW * hf + sharpShortW * shortness);

  let rep;
  if (f.reattackCount <= 1) rep = -0.6;
  else if (f.reattackCount === 2) rep = 0.0;
  else if (f.reattackCount === 3) rep = 0.4;
  else if (f.reattackCount === 4) rep = 0.7;
  else rep = 1.0;
  const noisy = lin(f.flatness, 0.05, 0.5);
  const rough = lin(f.envRoughnessDb, 0.5, 4.0);
  const texture = clamp(texReattackW * rep + texFlatW * noisy + texRoughW * rough);

  return { size, sharpness, texture, brightness };
}

/// ピッチ輪郭 (または傾き) → mora ごとの pitch オフセット (半音)。
export function pitchOffsets(contourSemis, slope, durationSec, moraCount) {
  if (moraCount < 2) return [];
  if (contourSemis.length >= 2) {
    const magnitude = Math.max(...contourSemis) - Math.min(...contourSemis);
    if (magnitude < 1.0) return pitchRamp(slope, durationSec, moraCount);
    const n = contourSemis.length;
    return Array.from({ length: moraCount }, (_, i) => {
      const pos = (i / (moraCount - 1)) * (n - 1);
      const j = Math.min(n - 2, Math.floor(pos));
      const u = pos - j;
      const s = contourSemis[j] * (1 - u) + contourSemis[j + 1] * u;
      return Math.max(-6, Math.min(6, s));
    });
  }
  return pitchRamp(slope, durationSec, moraCount);
}

export function pitchRamp(slope, durationSec, moraCount) {
  if (moraCount < 2 || Math.abs(slope) < 4.0) return [];
  const total = Math.max(-5, Math.min(5, slope * durationSec));
  if (Math.abs(total) < 1.0) return [];
  return Array.from({ length: moraCount }, (_, i) =>
    total * (i / (moraCount - 1) - 0.5));
}
