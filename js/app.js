//
// app.js — Ear Onomatopian web: Web Audio 接続と UI。
// パイプライン: マイク → SoundEventAnalyzer → mapAxes/shape → generate →
//               applyShape + pitchOffsets → renderEvent → 再生。
//

import { SeededRNG, deterministicSeed, generate, romaji, katakana,
         mirroredKana, CONSONANTS, VOWELS } from "./core.js";
import { SoundEventAnalyzer } from "./analyzer.js";
import { mapAxes, pitchOffsets } from "./mapper.js";
import { shape, applyShape } from "./shaper.js";
import { renderEvent } from "./renderer.js";
import { noteDisplay, melodyDisplay } from "./notes.js";
import { deriveEffects } from "./effects.js";

// ─── 音源リスト (KanaFormatter の組合せと一致: 録音済み 110 ファイル) ───
const RESTRICTED = { ky: ["a","u","o"], gy: ["a","u","o"], ny: ["a","u","o"],
                     y: ["a","u","o"], ch: ["a","i","u","o"] };
function sampleNames() {
  const names = [];
  for (const c of CONSONANTS) {
    for (const v of RESTRICTED[c] ?? VOWELS) names.push(`cv_${c}${v}`);
  }
  for (const v of VOWELS) names.push(`v_${v}`);
  names.push("n_N");
  return names;
}

// ─── 状態 ───
let ctx = null;            // AudioContext
let analyzer = null;
let samples = {};          // name → Float32Array
let loadedCount = 0;
let mutedUntil = 0;        // ctx.currentTime 基準
let history = [];
let speakingTimer = null;
let phase = "idle";        // idle | listening | capturing | speaking | denied

const $ = (id) => document.getElementById(id);

// ─── 起動 (ユーザー操作から呼ぶ: AudioContext + mic の許可) ───
async function start() {
  $("startOverlay").classList.add("hidden");
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();

  // 音源プリロード (decodeAudioData が ctx.sampleRate へリサンプルしてくれる)
  setStatus("loading", "音源を読み込んでいます…");
  const names = sampleNames();
  await Promise.all(names.map(async (name) => {
    try {
      const res = await fetch(`audio/${name}.wav`);
      if (!res.ok) return;
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      samples[name] = buf.getChannelData(0).slice();
      loadedCount++;
    } catch { /* 個別の失敗は許容 */ }
  }));
  $("loadInfo").textContent = `音源 ${loadedCount} 個`;

  analyzer = new SoundEventAnalyzer(ctx.sampleRate, 1024);
  applySensitivity();

  await ctx.audioWorklet.addModule("js/capture-worklet.js").catch(() => {});
  await startMic(null);
  await populateDeviceSelects();
}

// ─── マイク開始 / デバイス切替 ───
let micStream = null;
let micSrc = null;
let micNode = null;

async function startMic(deviceId) {
  // 既存の入力を畳む
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micSrc?.disconnect();
    micNode?.disconnect();
    micStream = null;
  }
  try {
    const audio = { echoCancellation: false, noiseSuppression: false,
                    autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    micStream = await navigator.mediaDevices.getUserMedia({ audio });
    micSrc = ctx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(ctx, "capture-processor");
    micNode.port.onmessage = (e) => onFrame(e.data);
    micSrc.connect(micNode);
    // worklet は出力不要 (接続しないと動かないブラウザがあるため gain 0 で繋ぐ)
    const sink = ctx.createGain();
    sink.gain.value = 0;
    micNode.connect(sink).connect(ctx.destination);
    analyzer.reset();
    setStatus("listening", "聴いています");
  } catch (err) {
    console.warn("mic unavailable:", err);
    setStatus("denied", "マイクが使えません — 下のテスト音で試せます");
  }
}

// ─── デバイス選択 (入力: getUserMedia deviceId / 出力: AudioContext.setSinkId) ───
async function populateDeviceSelects() {
  const inSel = $("inputSelect"), outSel = $("outputSelect");
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    inSel.innerHTML = `<option value="">既定のマイク</option>` +
      inputs.map((d, i) =>
        `<option value="${d.deviceId}">${d.label || `マイク ${i + 1}`}</option>`).join("");
    inSel.disabled = inputs.length === 0;

    if (typeof ctx.setSinkId === "function") {
      const outputs = devices.filter((d) => d.kind === "audiooutput");
      outSel.innerHTML = `<option value="">既定のスピーカー</option>` +
        outputs.map((d, i) =>
          `<option value="${d.deviceId}">${d.label || `スピーカー ${i + 1}`}</option>`).join("");
      outSel.disabled = outputs.length === 0;
    } else {
      outSel.innerHTML = `<option value="">このブラウザは出力切替非対応</option>`;
      outSel.disabled = true;
    }
  } catch (err) {
    console.warn("enumerateDevices failed:", err);
    inSel.disabled = true;
    outSel.disabled = true;
  }
}

// ─── フレーム処理 ───
function onFrame(frame) {
  if (!analyzer) return;
  if (ctx.currentTime < mutedUntil) {
    analyzer.reset();
    return;
  }
  const ev = analyzer.process(frame);
  updateLevel(analyzer.currentDb, analyzer.isActive);
  if (ev) handleEvent(ev);
}

let lastLevel = 0;
function updateLevel(db, active) {
  const now = performance.now();
  if (now - lastLevel > 80) {
    lastLevel = now;
    const pos = Math.max(0, Math.min(1, (db + 80) / 80));
    $("levelFill").style.width = `${pos * 100}%`;
  }
  if (phase === "listening" && active) setStatus("capturing", "聴き取り中…");
  else if (phase === "capturing" && !active) setStatus("listening", "聴いています");
}

// ─── イベント → オノマトペ ───
function handleEvent(features) {
  const axes = mapAxes(features);
  const sh = shape(features, axes.texture);

  const rng = new SeededRNG(deterministicSeed(axes));
  let event = generate(axes, { temperature: 0.35, allowNilOnset: true,
                               allowMoraicN: true,
                               moraCountOverride: sh.moraCount, rng });
  event = applyShape(sh, event);

  const offsets = pitchOffsets(features.pitchContourSemis,
                               features.pitchSlopeSemisPerSec,
                               features.durationSec, event.moras.length);
  if (offsets.length) {
    event.moras.forEach((m, i) => {
      if (i < offsets.length) m.pitchOffsetSemis = offsets[i];
    });
  }

  let kana = katakana(event.moras, sh.elongateFinal);
  let rom = romaji(event);
  if (sh.mirrorReverse) {
    kana = mirroredKana(kana);
    rom = rom + " / " + [...rom].reverse().join("");
  }

  const capture = { features, axes, shape: sh, event, kana, romaji: rom,
                    date: new Date() };
  window.__lastCapture = capture;   // デバッグ/検証用
  history.unshift(capture);
  if (history.length > 20) history.pop();
  renderCapture(capture);
  renderHistory();
  speak(capture);
}

// ─── 発声 ───
let effectsEnabled = true;

function speak(capture) {
  const { event, shape: sh } = capture;
  const fx = effectsEnabled ? deriveEffects(capture.features) : null;
  const r = renderEvent(event, samples, ctx.sampleRate, {
    gain: sh.replyGain, attackSec: sh.attackSec, mirrorReverse: sh.mirrorReverse,
    effects: fx,
  });
  if (!r || r.durationSec <= 0) return;
  const buf = ctx.createBuffer(1, r.data.length, ctx.sampleRate);
  buf.copyToChannel(r.data, 0);
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(ctx.destination);
  node.start();

  // 発声中 + 残響 0.35s はマイクを閉じる (自分の声に反応しない)
  const muteSec = r.durationSec + 0.35;
  mutedUntil = ctx.currentTime + muteSec;
  setStatus("speaking", "発声中…");
  clearTimeout(speakingTimer);
  speakingTimer = setTimeout(() => {
    if (phase === "speaking") setStatus("listening", "聴いています");
  }, muteSec * 1000);
}

// ─── UI ───
function setStatus(p, label) {
  phase = p;
  $("statusLabel").textContent = label;
  $("statusDot").dataset.phase = p;
}

function applySensitivity() {
  const v = Number($("sensitivity").value);
  $("sensValue").textContent = `${v} dB`;
  if (analyzer) {
    analyzer.onsetDb = v;
    analyzer.releaseDb = v - 10;
  }
}

function axisBar(name, value) {
  const pct = Math.abs(value) * 50;
  const side = value >= 0 ? "pos" : "neg";
  const pos = value >= 0 ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%`;
  return `<div class="axis">
    <span class="axisName">${name}</span>
    <div class="axisTrack"><div class="axisFill ${side}" style="${pos}"></div></div>
    <span class="axisVal">${value.toFixed(2)}</span>
  </div>`;
}

function renderCapture(c) {
  const f = c.features;
  const grid = [
    ["長さ", `${f.durationSec.toFixed(2)} s`],
    ["アタック", `${(f.attackSec * 1000).toFixed(0)} ms`],
    ["余韻", `${f.releaseSec.toFixed(2)} s`],
    ["ピーク", `${f.peakDb.toFixed(0)} dB`],
    ["重心", `${f.centroidHz.toFixed(0)} Hz`],
    ["ピッチ", f.pitchMedianHz > 0 ? `${f.pitchMedianHz.toFixed(0)} Hz` : "—"],
    ["音名", f.pitchMedianHz > 0 ? noteDisplay(f.pitchMedianHz) : "—"],
    ["傾き", `${f.pitchSlopeSemisPerSec >= 0 ? "+" : ""}${f.pitchSlopeSemisPerSec.toFixed(1)} st/s`],
    ["旋律", f.pitchContourSemis.length ? "あり" : "—"],
    ["再打", `${f.reattackCount}`],
    ["変化速", c.shape.changeSpeed.toFixed(2)],
    ["モーラ", `${c.shape.moraCount}${c.shape.elongateFinal ? "+ー" : ""}`],
    ["立上り", c.shape.attackSec > 0 ? `${(c.shape.attackSec * 1000).toFixed(0)} ms` : "即"],
    ["鏡像", c.shape.mirrorReverse ? "⇄ 逆再生" : "—"],
    ["声の高さ", c.shape.baseF0Override ? `${c.shape.baseF0Override.toFixed(0)} Hz` : "自動"],
    ["声量", `${(c.shape.replyGain * 100).toFixed(0)}%`],
  ];
  // 真似の生真面目さ: 入力のずれた音程 → きっちりドレミの返事 (MacTuner 連携)
  let tunerLine = "";
  if (c.shape.baseF0Override) {
    const melody = melodyDisplay(c.shape.baseF0Override,
                                 c.event.moras.map((m) => m.pitchOffsetSemis));
    tunerLine = `<div class="tunerLine">${noteDisplay(c.features.pitchMedianHz)}
      と聴こえたので ${melody} で返しました</div>`;
  }
  $("captureCard").classList.remove("placeholder");
  $("captureCard").innerHTML = `
    <div class="panel-title">RESULT</div>
    <div class="kana">${c.kana}</div>
    <div class="romaji">${c.romaji}</div>
    ${tunerLine}
    <div class="axes">
      ${axisBar("大小", c.axes.size)}
      ${axisBar("鋭鈍", c.axes.sharpness)}
      ${axisBar("粗滑", c.axes.texture)}
      ${axisBar("明暗", c.axes.brightness)}
    </div>
    <div class="featGrid">
      ${grid.map(([k, v]) => `<div class="feat"><span>${k}</span><b>${v}</b></div>`).join("")}
    </div>`;
  $("captureCard").classList.remove("placeholder");
}

function renderHistory() {
  $("historyList").innerHTML = history.map((c, i) => `
    <div class="histRow">
      <span class="histKana">${c.kana}</span>
      <span class="histMeta">${c.features.durationSec.toFixed(2)}s ・ ${c.romaji}</span>
      <button data-i="${i}" class="replayBtn">play</button>
    </div>`).join("");
  for (const btn of document.querySelectorAll(".replayBtn")) {
    btn.onclick = () => {
      const c = history[Number(btn.dataset.i)];
      renderCapture(c);
      speak(c);
    };
  }
}

// ─── テスト音 (マイク無しでも遊べる + パイプラインの実演) ───
function synthAndFeed(makeSignal) {
  if (!ctx) return;
  const sr = ctx.sampleRate;
  const an = new SoundEventAnalyzer(sr, 1024);
  an.onsetDb = Number($("sensitivity").value);
  an.releaseDb = an.onsetDb - 10;
  const sig = makeSignal(sr);
  const padded = new Float32Array(sig.length + Math.floor(0.8 * sr));
  padded.set(sig, 0);
  for (let i = 0; i + 1024 <= padded.length; i += 1024) {
    const ev = an.process(padded.subarray(i, i + 1024));
    if (ev) { handleEvent(ev); return; }
  }
}

const DEMOS = {
  clap: (sr) => {
    const n = Math.floor(0.09 * sr);
    const out = new Float32Array(n);
    let s = 1;
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647;
      out[i] = (s / 2147483647 * 2 - 1) * 0.5 * Math.exp(-6 * i / n);
    }
    return out;
  },
  bell: (sr) => {
    const n = Math.floor(1.1 * sr);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      out[i] = 0.4 * Math.exp(-3 * t)
             * (Math.sin(2 * Math.PI * 1318 * t) + 0.6 * Math.sin(2 * Math.PI * 2093 * t));
    }
    return out;
  },
  whistle: (sr) => {
    // 380→760Hz の 1 オクターブ上昇 (ピッチ検出域 95–800Hz に収める)
    const n = Math.floor(0.7 * sr);
    const out = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = 380 * Math.pow(2, (i / n) * 1.0);
      phase += 2 * Math.PI * f / sr;
      out[i] = 0.3 * Math.sin(phase);
    }
    return out;
  },
  growl: (sr) => {
    const n = Math.floor(1.4 * sr);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.1) * Math.min(1, (n / sr - t) / 0.2);
      out[i] = 0.45 * env * (Math.sin(2 * Math.PI * 110 * t)
                           + 0.5 * Math.sin(2 * Math.PI * 221 * t + 0.7));
    }
    return out;
  },
  swell2: (sr) => {
    const one = (off, out) => {
      const rise = Math.floor(0.32 * sr), fall = Math.floor(0.26 * sr);
      for (let i = 0; i < rise + fall; i++) {
        const env = i < rise ? i / rise : (rise + fall - i) / fall;
        out[off + i] = 0.35 * env * Math.sin(2 * Math.PI * 240 * (off + i) / sr);
      }
      return off + rise + fall;
    };
    const out = new Float32Array(Math.floor(1.3 * sr));
    one(one(0, out), out);
    return out;
  },
};

// ─── 配線 ───
$("startBtn").onclick = () => start().catch((e) => {
  console.error(e);
  setStatus("denied", "起動に失敗しました");
});
$("sensitivity").oninput = applySensitivity;
$("fxToggle").onchange = () => { effectsEnabled = $("fxToggle").checked; };
$("rescanDevices").onclick = () => { if (ctx) populateDeviceSelects(); };
$("inputSelect").onchange = () => {
  if (ctx) startMic($("inputSelect").value || null);
};
$("outputSelect").onchange = async () => {
  if (ctx && typeof ctx.setSinkId === "function") {
    try {
      await ctx.setSinkId($("outputSelect").value || "");
    } catch (err) {
      console.warn("setSinkId failed:", err);
    }
  }
};
for (const [key, fn] of Object.entries(DEMOS)) {
  const el = $(`demo-${key}`);
  if (el) el.onclick = () => synthAndFeed(fn);
}
applySensitivity();
