//
// percussion.js — EarPercussion の JS 移植 (2026-06-14)。
// 打楽器ライク (非声トランジェント) を代表語に寄せる。Swift Ear/EarPercussion.swift と 1:1。
//   キック→ドン/ドーン, タム→ドコ, スネア→タン, 手拍子→パン,
//   ハイハット→チッ, シンバル→バシャーン/シャーン
//

const KIND_LABEL = {
  kick: "キック", bigKick: "キック", tom: "タム", snare: "スネア",
  clap: "手拍子", hihat: "ハイハット", cymbal: "シンバル", sizzle: "シンバル",
};

function cv(onset, nucleus, ms = 160, voiced = 1) {
  return { onset, nucleus, durationMs: ms, geminateGapMs: 0, voicing: voiced,
           amplitude: 1, isMoraicN: false, pitchOffsetSemis: 0 };
}
function nasal() {
  return { onset: null, nucleus: "a", durationMs: 160, geminateGapMs: 0,
           voicing: 1, amplitude: 1, isMoraicN: true, pitchOffsetSemis: 0 };
}

function kit(kind) {
  switch (kind) {
    case "kick":    return { kind, moras: [cv("d","o"), nasal()], baseF0: 95,  elongateFinal: false, kanaOverride: null };
    case "bigKick": return { kind, moras: [cv("d","o"), nasal()], baseF0: 80,  elongateFinal: true,  kanaOverride: null };
    case "tom":     return { kind, moras: [cv("d","o"), cv("k","o")], baseF0: 120, elongateFinal: false, kanaOverride: null };
    case "snare":   return { kind, moras: [cv("t","a"), nasal()], baseF0: 160, elongateFinal: false, kanaOverride: null };
    case "clap":    return { kind, moras: [cv("p","a"), nasal()], baseF0: 175, elongateFinal: false, kanaOverride: null };
    case "hihat":   return { kind, moras: [cv("ch","i",110,0)], baseF0: 240, elongateFinal: false, kanaOverride: "チッ" };
    case "cymbal":  return { kind, moras: [cv("b","a"), cv("sh","a",160,0), nasal()], baseF0: 200, elongateFinal: true, kanaOverride: null };
    case "sizzle":  return { kind, moras: [cv("sh","a",160,0), nasal()], baseF0: 200, elongateFinal: true, kanaOverride: null };
  }
}

/// 打楽器ライクなら代表語テンプレート (+ label) を返す。声/音程なら null。
export function matchPercussion(f) {
  const sustainedVoice = f.voicedRatio > 0.5 && f.durationSec > 0.25
    && f.pitchMedianHz >= 80 && f.pitchMedianHz <= 500;
  if (sustainedVoice) return null;
  if (f.attackSec >= 0.09) return null;

  const c = f.centroidHz, flat = f.flatness, rel = f.releaseSec, dur = f.durationSec;
  let hit;
  if (c < 300) {
    const big = dur > 0.38 || rel > 0.32 || c < 150;
    hit = kit(big ? "bigKick" : "kick");
  } else if (c < 850) {
    hit = kit(flat > 0.42 ? "snare" : "tom");
  } else if (c < 2600) {
    hit = kit(rel < 0.13 && flat > 0.45 ? "clap" : "snare");
  } else {
    if (rel >= 0.26) {
      const crash = c > 5200 && f.peakDb > -22;
      hit = kit(crash ? "cymbal" : "sizzle");
    } else {
      hit = kit("hihat");
    }
  }
  hit.label = KIND_LABEL[hit.kind];
  return hit;
}
