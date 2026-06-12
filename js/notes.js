//
// notes.js — NoteNamer の JS 移植 (MacTuner 連携, 2026-06-13)。
// Hz → カタカナドレミ。入力の音名+セントずれ表示と、返事の旋律表示 (♪ソ・ミ・ソ)。
//

export const REFERENCE_A4 = 440.0;
export const SOLFEGE = ["ド", "ド♯", "レ", "レ♯", "ミ", "ファ",
                        "ファ♯", "ソ", "ソ♯", "ラ", "ラ♯", "シ"];

/// 平均律の最寄り半音へスナップ。
export function snapToEqualTemperament(hz) {
  if (hz <= 0) return hz;
  const semis = Math.round(12 * Math.log2(hz / REFERENCE_A4));
  return REFERENCE_A4 * Math.pow(2, semis / 12);
}

/// Hz → { name, octave, cents } (hz <= 0 は null)。
export function noteName(hz) {
  if (hz <= 0) return null;
  const semitones = 12 * Math.log2(hz / REFERENCE_A4);
  const rounded = Math.round(semitones);
  const cents = (semitones - rounded) * 100;
  const midi = 69 + rounded;
  const octave = Math.floor(midi / 12) - 1;
  const idx = ((midi % 12) + 12) % 12;
  return { name: SOLFEGE[idx], octave, cents };
}

/// チューナー風表示: 「ラ3 +23¢」。±3¢ 未満はぴったり扱い。
export function noteDisplay(hz) {
  const n = noteName(hz);
  if (!n) return "—";
  if (Math.abs(n.cents) < 3) return `${n.name}${n.octave}`;
  return `${n.name}${n.octave} ${n.cents >= 0 ? "+" : ""}${n.cents.toFixed(0)}¢`;
}

/// 返事の旋律: baseF0 + mora オフセット列 → 「♪ソ・ミ・ソ」。
export function melodyDisplay(baseF0, offsets) {
  if (baseF0 <= 0) return "";
  let names;
  if (!offsets.length || offsets.every((o) => o === 0)) {
    names = [noteName(baseF0)?.name ?? "?"];
  } else {
    names = offsets.map((off) =>
      noteName(baseF0 * Math.pow(2, off / 12))?.name ?? "?");
  }
  return "♪" + names.join("・");
}
