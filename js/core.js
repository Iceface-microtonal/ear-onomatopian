//
// core.js — Ear Onomatopian web
//
// PTS コア (PhonosymbolicAxes / SeededGenerator / CVGenerator / Kana) の JS 移植。
// Swift 版 Shared/Core/{CVGenerator,PhonosymbolicEvent}.swift と 1:1 対応。
// 決定性 (同じ軸 → 同じ語) を保つため、RNG は BigInt で UInt64 演算を再現する。
//

const MASK64 = (1n << 64n) - 1n;

// ─── SplitMix64 (Swift SeededGenerator と同一) ───
export class SeededRNG {
  constructor(seed /* BigInt */) { this.state = BigInt(seed) & MASK64; }
  next() {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }
  /// Swift Double.random(in: 0..<1, using:) と同一: 下位 53 bit * 2^-53
  /// (Swift stdlib の next(upperBound: 2^53) は下位ビットを採る — 実測でパリティ確認済み)
  nextDouble() {
    return Number(this.next() & ((1n << 53n) - 1n)) * Math.pow(2, -53);
  }
}

// ─── 軸 → 決定的 seed (Swift deterministicSeed と同一) ───
export function deterministicSeed(axes, salt = 0n) {
  const q = (x) => {
    const scaled = BigInt(Math.round(x * 10000.0));
    return scaled & MASK64; // Int64 bitPattern → UInt64
  };
  let h = (0xcbf29ce484222325n ^ BigInt(salt)) & MASK64;
  for (const v of [q(axes.size), q(axes.sharpness), q(axes.texture), q(axes.brightness)]) {
    h = ((h ^ v) * 0x100000001b3n) & MASK64;
    h = (h ^ (h >> 29n)) & MASK64;
  }
  return h === 0n ? 0x9e3779b97f4a7c15n : h;
}

// ─── 音素 inventory ───
export const CONSONANTS = ["k","g","t","d","p","b","m","n","s","sh","ts","r","w",
                           "ky","gy","ny","h","f","y","z","j","ch"];
export const VOWELS = ["a","i","u","e","o"];

const VOICED = new Set(["g","d","b","m","n","r","w","gy","ny","y","z","j"]);
const PALATALIZED = new Set(["ky","gy","ny"]);

export const isVoiced = (c) => VOICED.has(c);

// ─── bias 表 (docs §2, v0.4) — Swift consonantBias / vowelBias と同一 ───
const A = (size, sharpness, texture, brightness) => ({ size, sharpness, texture, brightness });

export const consonantBias = {
  k:  A(-0.4, +0.80,  0.0, +0.3),
  g:  A(+0.6, +0.50,  0.0, -0.3),
  t:  A(-0.2, +0.70,  0.0,  0.0),
  d:  A(+0.4, +0.35,  0.0, -0.2),
  p:  A(-0.3, +0.40,  0.0,  0.0),
  b:  A(+0.5, +0.15,  0.0, -0.3),
  m:  A(+0.20, -0.70, 0.0, -0.3),
  n:  A(+0.10, -0.60, 0.0,  0.0),
  s:  A(-0.3, +0.60,  0.0, +0.6),
  sh: A( 0.0, +0.30,  0.0, -0.2),
  ts: A(-0.2, +0.80, +0.3, +0.2),
  r:  A( 0.0, -0.20, +0.5,  0.0),
  w:  A(+0.3, -0.60,  0.0, -0.4),
  ky: A(-0.5, +0.70,  0.0, +0.65),
  gy: A(+0.30, +0.40, +0.10, +0.0),
  ny: A(+0.0, -0.50, +0.10, +0.30),
  h:  A(-0.20, -0.10, +0.10, +0.20),
  f:  A(-0.10, -0.20, +0.15,  0.0),
  y:  A(+0.10, -0.55, +0.20, +0.50),
  z:  A(+0.20, +0.20, +0.40, +0.20),
  j:  A(+0.30, +0.10, +0.45, +0.10),
  ch: A(-0.35, +0.70, +0.15, +0.25),
};

export const vowelBias = {
  a: A(+0.80,  0.0, 0.0, -0.30),
  o: A(+0.55, -0.3, 0.0, -0.70),
  u: A(+0.20, -0.4, 0.0, -0.50),
  e: A(-0.30,  0.0, 0.0, +0.60),
  i: A(-0.85, +0.3, 0.0, +0.90),
};

// nil-onset (母音単独) スコアのパラメータ (v0.4)
const NIL_ONSET_BASE = -0.68;
const NIL_ONSET_SHARP_PENALTY = 1.45;
const NIL_ONSET_DULL_BONUS = 0.0;

// ─── score 関数 (docs §3 Step 2, v0.3 重み) ───
function scoreAgainst(target, bias) {
  return -(0.7 * Math.abs(bias.size - target.size)
         +       Math.abs(bias.sharpness - target.sharpness)
         +       Math.abs(bias.brightness - target.brightness));
}

/// Softmax sampling。temperature < 1e-3 で greedy。Swift 版と同じ走査順。
function softmaxSample(scores, temperature, rng) {
  if (scores.length === 0) return undefined;
  if (temperature < 1e-3) {
    let best = scores[0];
    for (const s of scores) if (s[1] > best[1]) best = s; // 同点は最初の最大
    return best[0];
  }
  const maxScore = Math.max(...scores.map((s) => s[1]));
  const exps = scores.map((s) => [s[0], Math.exp((s[1] - maxScore) / temperature)]);
  const sumExp = exps.reduce((a, e) => a + e[1], 0);
  if (sumExp <= 0) return scores[0][0];
  const r = rng.nextDouble();
  let cum = 0;
  for (const [item, e] of exps) {
    cum += e / sumExp;
    if (r < cum) return item;
  }
  return exps[exps.length - 1][0];
}

function pickConsonant(target, previousOnset, temperature, allowNilOnset, rng) {
  const scores = [];
  if (allowNilOnset) {
    let nilScore = NIL_ONSET_BASE
                 - NIL_ONSET_SHARP_PENALTY * Math.max(0, target.sharpness)
                 + NIL_ONSET_DULL_BONUS * Math.max(0, -target.sharpness);
    if (previousOnset === null) nilScore -= 0.4;
    scores.push([null, nilScore]);
  }
  for (const c of CONSONANTS) {
    let s = scoreAgainst(target, consonantBias[c]);
    if (previousOnset === c) s -= 0.3;
    scores.push([c, s]);
  }
  const r = softmaxSample(scores, temperature, rng);
  return r === undefined ? null : r;
}

function pickVowel(target, reduplicateOf, temperature, restrictTo, rng) {
  const scores = [];
  for (const v of VOWELS) {
    if (restrictTo && !restrictTo.has(v)) continue;
    let s = scoreAgainst(target, vowelBias[v]);
    if (reduplicateOf && reduplicateOf === v) s += 0.3;
    scores.push([v, s]);
  }
  return softmaxSample(scores, temperature, rng) ?? "a";
}

function geminateGapMs(c) {
  if (c === null || c === undefined) return 70.0;
  switch (c) {
    case "k": case "t": case "p": return 110.0;
    case "s": case "sh": case "ts": return 65.0;
    case "g": case "d": case "b": return 85.0;
    case "m": case "n": case "r": case "w": return 55.0;
    case "ky": return 110.0;
    case "gy": return 85.0;
    case "ny": return 55.0;
    case "h": case "f": return 65.0;
    case "y": return 55.0;
    case "z": case "j": return 75.0;
    case "ch": return 110.0;
    default: return 70.0;
  }
}

// ─── CVGenerator.generate の移植 ───
// 返値 event: { axes, moras: [{onset, nucleus, durationMs, geminateGapMs,
//   voicing, amplitude, isMoraicN, pitchOffsetSemis}], baseF0, isReduplicated }
export function generate(axes, { temperature = 0.4, allowNilOnset = false,
                                 allowMoraicN = false, moraCountOverride = null,
                                 rng } = {}) {
  // Step 1: mora 数 / 反復 / 促音
  const rawCount = 2.0 + (axes.texture + 1.0) * 1.5;
  const moraCount = Math.max(1, Math.min(6,
    moraCountOverride !== null && moraCountOverride !== undefined
      ? moraCountOverride : Math.round(rawCount)));
  const isReduplicated = axes.texture > 0.6;
  const geminateOn = (axes.texture > 0.6 && axes.sharpness > 0.0) || axes.texture > 0.85;
  const uniqueCount = isReduplicated ? Math.min(2, moraCount) : moraCount;

  // Step 2 & 3: unique mora 列
  const uniqueMoras = [];
  // 注: Swift では初回の previousOnset も「母音単独の直前」も同じ nil。
  // 初回から nil-onset 連続抑制 (-0.4) が掛かる挙動まで含めて同一に移植する。
  let prevOnset = null;
  let firstVowel = null;
  for (let k = 0; k < uniqueCount; k++) {
    const onset = pickConsonant(axes, prevOnset, temperature, allowNilOnset, rng);
    const needsAUO = PALATALIZED.has(onset) || onset === "y";
    let restrict = null;
    if (needsAUO) restrict = new Set(["a", "u", "o"]);
    else if (onset === "ch") restrict = new Set(["a", "i", "u", "o"]);
    const nucleus = pickVowel(axes, isReduplicated ? firstVowel : null,
                              temperature, restrict, rng);
    if (firstVowel === null) firstVowel = nucleus;
    const duration = 170.0 + axes.size * 20.0;
    const voicing = (onset === null || isVoiced(onset)) ? 1.0 : 0.0;
    uniqueMoras.push({ onset, nucleus, durationMs: duration, geminateGapMs: 0,
                       voicing, amplitude: 1.0, isMoraicN: false, pitchOffsetSemis: 0 });
    prevOnset = onset;
  }

  // 反復 tile + 促音 gap + decrescendo
  const moras = [];
  for (let i = 0; i < moraCount; i++) {
    const u = uniqueMoras[i % uniqueCount];
    const needsGap = geminateOn && i === uniqueCount && uniqueCount < moraCount;
    const gap = needsGap ? geminateGapMs(u.onset) : 0.0;
    const cycleIndex = Math.floor(i / uniqueCount);
    const amplitude = (isReduplicated && cycleIndex > 0)
      ? Math.max(0.7, 1.0 - 0.08 * cycleIndex) : 1.0;
    moras.push({ onset: u.onset, nucleus: u.nucleus, durationMs: u.durationMs,
                 geminateGapMs: gap, voicing: u.voicing, amplitude,
                 isMoraicN: false, pitchOffsetSemis: 0 });
  }

  // Stage 2c: 撥音末尾付与
  if (allowMoraicN && moras.length > 0) {
    const nScore = 0.5 * axes.size + 0.3 * axes.sharpness - 0.3 * axes.texture;
    const probability = Math.max(0, Math.min(1, 0.15 + nScore * 0.30));
    if (rng.nextDouble() < probability) {
      moras.push({ onset: null, nucleus: "a", durationMs: 160, geminateGapMs: 0,
                   voicing: 1.0, amplitude: 1.0, isMoraicN: true, pitchOffsetSemis: 0 });
    }
  }

  // Step 4: baseF0
  const f0Raw = 200.0 * (1.0 + 0.2 * axes.brightness - 0.2 * axes.size);
  const baseF0 = Math.max(80.0, Math.min(400.0, f0Raw));

  return { axes, moras, baseF0, isReduplicated };
}

export const isSilentRest = (m) => m.amplitude <= 0 && !m.isMoraicN;

export function totalDurationMs(event) {
  return event.moras.reduce((a, m) => a + m.durationMs + m.geminateGapMs, 0);
}

export function romaji(event) {
  let s = "";
  for (const m of event.moras) {
    if (isSilentRest(m)) continue;
    if (m.geminateGapMs > 0) s += "Q";
    if (m.isMoraicN) s += "N";
    else s += (m.onset ?? "") + m.nucleus;
  }
  return s;
}

// ─── KanaFormatter ───
const KANA = {
  "":   { a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ" },
  k:    { a: "カ", i: "キ", u: "ク", e: "ケ", o: "コ" },
  g:    { a: "ガ", i: "ギ", u: "グ", e: "ゲ", o: "ゴ" },
  t:    { a: "タ", i: "ティ", u: "トゥ", e: "テ", o: "ト" },
  d:    { a: "ダ", i: "ディ", u: "ドゥ", e: "デ", o: "ド" },
  p:    { a: "パ", i: "ピ", u: "プ", e: "ペ", o: "ポ" },
  b:    { a: "バ", i: "ビ", u: "ブ", e: "ベ", o: "ボ" },
  m:    { a: "マ", i: "ミ", u: "ム", e: "メ", o: "モ" },
  n:    { a: "ナ", i: "ニ", u: "ヌ", e: "ネ", o: "ノ" },
  s:    { a: "サ", i: "スィ", u: "ス", e: "セ", o: "ソ" },
  sh:   { a: "シャ", i: "シ", u: "シュ", e: "シェ", o: "ショ" },
  ts:   { a: "ツァ", i: "ツィ", u: "ツ", e: "ツェ", o: "ツォ" },
  r:    { a: "ラ", i: "リ", u: "ル", e: "レ", o: "ロ" },
  w:    { a: "ワ", i: "ウィ", u: "ウゥ", e: "ウェ", o: "ヲ" },
  ky:   { a: "キャ", u: "キュ", o: "キョ" },
  gy:   { a: "ギャ", u: "ギュ", o: "ギョ" },
  ny:   { a: "ニャ", u: "ニュ", o: "ニョ" },
  h:    { a: "ハ", i: "ヒ", u: "フ", e: "ヘ", o: "ホ" },
  f:    { a: "ファ", i: "フィ", u: "フ", e: "フェ", o: "フォ" },
  y:    { a: "ヤ", u: "ユ", o: "ヨ" },
  z:    { a: "ザ", i: "ズィ", u: "ズ", e: "ゼ", o: "ゾ" },
  j:    { a: "ジャ", i: "ジ", u: "ジュ", e: "ジェ", o: "ジョ" },
  ch:   { a: "チャ", i: "チ", u: "チュ", o: "チョ" },
};

export function katakana(moras, elongateLast = false) {
  let s = "";
  let lastVowelEnd = -1;
  for (const m of moras) {
    if (isSilentRest(m)) continue;
    if (m.geminateGapMs > 0) s += "ッ";
    if (m.isMoraicN) {
      s += "ン";
    } else {
      const key = m.onset ?? "";
      s += (KANA[key] && KANA[key][m.nucleus]) || "?";
      lastVowelEnd = s.length;
    }
  }
  if (elongateLast && lastVowelEnd > 0) {
    s = s.slice(0, lastVowelEnd) + "ー" + s.slice(lastVowelEnd);
  }
  return s;
}

export function mirroredKana(kana) {
  return kana + " ⇄ " + [...kana].reverse().join("");
}
