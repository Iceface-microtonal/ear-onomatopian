//
// analyzer.js — SoundEventAnalyzer の JS 移植 (Web Audio 非依存の純ロジック)。
// マイク入力 (Float32Array, mono) をフレーム単位で解析し、無音で区切られた
// 「1 音イベント」の音響特徴を集計する。Swift 版 SoundEventAnalyzer.swift と 1:1。
//

// ─── radix-2 複素 FFT (in-place, n は 2 の冪) ───
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

export class SoundEventAnalyzer {
  constructor(sampleRate, frameSize = 1024) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.frameDurSec = frameSize / sampleRate;

    // チューニング可能パラメータ (Swift 版と同値)
    this.onsetDb = -38;
    this.releaseDb = -48;
    this.silenceHoldSec = 0.45;
    this.maxEventSec = 4.0;
    this.minEventSec = 0.04;
    this.minPeakDb = -34;

    // 状態
    this.isActive = false;
    this.currentDb = -80;
    this.frames = [];
    this.preroll = [];
    this.silentSec = 0;
    this.clockSec = 0;

    // DSP リソース
    const n = frameSize;
    this.window = new Float32Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    this.fftRe = new Float64Array(n);
    this.fftIm = new Float64Array(n);
    this.magnitudes = new Float64Array(n / 2);
    this.smoothMags = new Float64Array(n / 2);
    this.smoothMagsValid = false;
    // YIN ピッチ検出用リングバッファ (MacTuner 連携, 2026-06-13)。
    // JS は vDSP が無いので窓 2048 (Swift 版は 4096)。検出域 ~45Hz–2000Hz。
    this.yinWindowSize = 2048;
    this.pitchRing = new Float32Array(this.yinWindowSize);
    this.pitchRingFill = 0;
  }

  reset() {
    this.isActive = false;
    this.frames.length = 0;
    this.preroll.length = 0;
    this.silentSec = 0;
    this.currentDb = -80;
    this.smoothMagsValid = false;
    this.pitchRingFill = 0;
  }

  /// frameSize サンプルのフレームを 1 つ処理。イベント終端で集計特徴を返す。
  process(samples) {
    if (samples.length !== this.frameSize) throw new Error("frame size mismatch");
    const f = this.analyzeFrame(samples);
    this.clockSec += this.frameDurSec;
    this.currentDb = f.db;

    if (!this.isActive) {
      if (f.db > this.onsetDb) {
        this.isActive = true;
        this.silentSec = 0;
        this.frames = [...this.preroll, f];
      } else {
        this.preroll.push(f);
        if (this.preroll.length > 2) this.preroll.shift();
      }
      return null;
    }

    this.frames.push(f);
    if (f.db < this.releaseDb) this.silentSec += this.frameDurSec;
    else this.silentSec = 0;

    const eventDur = this.frames.length * this.frameDurSec;
    if (this.silentSec >= this.silenceHoldSec || eventDur >= this.maxEventSec) {
      const result = this.finalizeEvent();
      this.isActive = false;
      this.frames = [];
      this.preroll = [];
      this.silentSec = 0;
      return result;
    }
    return null;
  }

  // ─── イベント集計 ───
  finalizeEvent() {
    const active = [...this.frames];
    while (active.length && active[active.length - 1].db < this.releaseDb) active.pop();
    if (!active.length) return null;

    const dur = active.length * this.frameDurSec;
    if (dur < this.minEventSec) return null;

    const peakRms = Math.max(...active.map((f) => f.rms));
    const peakDb = this.dbOf(peakRms);
    if (peakDb < this.minPeakDb) return null;

    const meanDb = active.reduce((a, f) => a + f.db, 0) / active.length;

    // attack / release
    let attackSec = dur, peakIndex = 0;
    for (let i = 0; i < active.length; i++) {
      if (active[i].rms >= peakRms * 0.9) {
        attackSec = i * this.frameDurSec + this.frameDurSec * 0.5;
        peakIndex = i;
        break;
      }
    }
    const releaseSec = (active.length - 1 - peakIndex) * this.frameDurSec;

    // rms 加重平均
    const totalRms = Math.max(1e-9, active.reduce((a, f) => a + f.rms, 0));
    const weighted = (key) => active.reduce((a, f) => a + f.rms * f[key], 0) / totalRms;
    const centroid = weighted("centroidHz");
    const flatness = weighted("flatness");
    const zcr = weighted("zcr");
    const spectralFlux = weighted("flux");

    // pitch 統計
    const voiced = [];
    active.forEach((f, i) => {
      if (f.pitchConfidence > 0.55 && f.pitchHz > 0) voiced.push([i, f]);
    });
    const voicedRatio = voiced.length / active.length;
    let pitchMedian = 0, pitchSlope = 0;
    let pitchContour = [];
    if (voiced.length > 0) {
      const sorted = voiced.map(([, f]) => f.pitchHz).slice().sort((a, b) => a - b);
      pitchMedian = sorted[Math.floor(sorted.length / 2)];
      if (voiced.length >= 4) {
        const pts = voiced.map(([i, f]) => ({
          t: i * this.frameDurSec,
          s: 12 * Math.log2(f.pitchHz / 440),
        }));
        const span = pts[pts.length - 1].t - pts[0].t;
        if (span >= 0.15) {
          const n = pts.length;
          const sumT = pts.reduce((a, p) => a + p.t, 0);
          const sumS = pts.reduce((a, p) => a + p.s, 0);
          const sumTT = pts.reduce((a, p) => a + p.t * p.t, 0);
          const sumTS = pts.reduce((a, p) => a + p.t * p.s, 0);
          const denom = n * sumTT - sumT * sumT;
          if (denom > 1e-9) pitchSlope = (n * sumTS - sumT * sumS) / denom;
          // ピッチ輪郭 8 点 (中央値比半音)
          const sVals = pts.map((p) => p.s).slice().sort((a, b) => a - b);
          const medianSemis = sVals[Math.floor(pts.length / 2)];
          const K = 8;
          pitchContour = Array.from({ length: K }, (_, i) => {
            const t = pts[0].t + (span * i) / (K - 1);
            let j = 0;
            while (j < pts.length - 2 && pts[j + 1].t < t) j++;
            const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
            let s = a.s;
            if (b.t > a.t) {
              const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
              s = a.s + (b.s - a.s) * u;
            }
            return s - medianSemis;
          });
        }
      }
    }

    // 再アタック + スウェル→谷→スウェル
    const rmsTrack = active.map((f) => f.rms);
    const onsets = this.envelopeOnsets(rmsTrack);
    const reattackCount = Math.max(1, onsets.length);
    const isSwellValleySwell = this.detectSwellValleySwell(rmsTrack, onsets);

    // 粗さ
    let roughness = 0;
    if (active.length >= 2) {
      for (let i = 1; i < active.length; i++) {
        roughness += Math.abs(active[i].db - active[i - 1].db);
      }
      roughness /= active.length - 1;
    }

    return {
      durationSec: dur, peakDb, meanDb, attackSec, releaseSec,
      centroidHz: centroid, flatness, zcr, voicedRatio,
      pitchMedianHz: pitchMedian, pitchSlopeSemisPerSec: pitchSlope,
      reattackCount, envRoughnessDb: roughness, spectralFlux,
      pitchContourSemis: pitchContour, isSwellValleySwell,
    };
  }

  /// arm/disarm 式 onset 検出 (Swift envelopeOnsets と同一)。
  envelopeOnsets(rms) {
    if (rms.length < 2) return rms.length ? [0] : [];
    const smooth = new Float64Array(rms.length);
    for (let i = 0; i < rms.length; i++) {
      const lo = Math.max(0, i - 1), hi = Math.min(rms.length - 1, i + 1);
      let s = 0;
      for (let j = lo; j <= hi; j++) s += rms[j];
      smooth[i] = s / (hi - lo + 1);
    }
    const openLin = Math.pow(10, (this.releaseDb + 8) / 20);
    const onsets = [];
    let armed = true, valley = 1e-6, peakSince = 0;
    for (let i = 0; i < smooth.length; i++) {
      const v = smooth[i];
      if (armed) {
        if (v > valley * 2.2 && v > openLin) {
          onsets.push(i);
          armed = false;
          peakSince = v;
        } else {
          valley = Math.min(valley, Math.max(v, 1e-6));
        }
      } else {
        peakSince = Math.max(peakSince, v);
        if (v < peakSince * 0.4) {
          armed = true;
          valley = Math.max(v, 1e-6);
        }
      }
    }
    return onsets;
  }

  detectSwellValleySwell(rms, onsets) {
    if (onsets.length < 2) return false;
    const starts = [...onsets];
    starts[0] = 0;
    let slowCount = 0;
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1] : rms.length;
      if (e - s < 8) continue;
      const seg = rms.slice(s, e);
      const peak = Math.max(...seg);
      if (peak <= 0) continue;
      let attackFrames = seg.length;
      for (let j = 0; j < seg.length; j++) {
        if (seg[j] >= peak * 0.9) { attackFrames = j; break; }
      }
      if (attackFrames * this.frameDurSec >= 0.12) slowCount++;
    }
    return slowCount >= 2;
  }

  // ─── フレーム解析 (DSP) ───
  dbOf(rms) {
    return rms > 1e-6 ? Math.max(-80, 20 * Math.log10(rms)) : -80;
  }

  analyzeFrame(x) {
    const n = this.frameSize;

    // ピッチリング更新 (無音でも進める: イベント頭で古い音を見ないように)
    const W = this.yinWindowSize;
    if (x.length >= W) {
      this.pitchRing.set(x.subarray(x.length - W));
      this.pitchRingFill = W;
    } else {
      this.pitchRing.copyWithin(0, x.length);
      this.pitchRing.set(x, W - x.length);
      this.pitchRingFill = Math.min(W, this.pitchRingFill + x.length);
    }

    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += x[i] * x[i];
    const rms = Math.sqrt(sumSq / n);
    const db = this.dbOf(rms);

    let zc = 0;
    for (let i = 1; i < n; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) zc++;
    const zcr = zc / (n - 1);

    if (db <= -66) {   // 高感度設定でも小さな音を解析できるよう下限を下げる
      this.smoothMagsValid = false;
      return { rms, db, centroidHz: 0, flatness: 0, flux: 0, zcr,
               pitchHz: 0, pitchConfidence: 0 };
    }

    // ─── スペクトル重心 + 平坦度 + 流量 (Hann 窓 FFT) ───
    for (let i = 0; i < n; i++) {
      this.fftRe[i] = x[i] * this.window[i];
      this.fftIm[i] = 0;
    }
    fft(this.fftRe, this.fftIm);
    const half = n / 2;
    const binHz = this.sampleRate / n;
    for (let k = 0; k < half; k++) {
      this.magnitudes[k] = Math.hypot(this.fftRe[k], this.fftIm[k]);
    }
    const mags = this.magnitudes;

    const loC = Math.max(1, Math.floor(80 / binHz));
    const hiC = Math.min(half - 1, Math.floor(10000 / binHz));
    let num = 0, den = 0;
    for (let k = loC; k <= hiC; k++) {
      num += k * binHz * mags[k];
      den += mags[k];
    }
    const centroidHz = den > 1e-6 ? num / den : 0;

    const loF = Math.max(1, Math.floor(200 / binHz));
    const hiF = Math.min(half - 1, Math.floor(8000 / binHz));
    let logSum = 0, linSum = 0;
    const nF = hiF - loF + 1;
    for (let k = loF; k <= hiF; k++) {
      const p = mags[k] * mags[k] + 1e-12;
      logSum += Math.log(p);
      linSum += p;
    }
    const gm = Math.exp(logSum / nF), am = linSum / nF;
    const flatness = am > 1e-12 ? Math.min(1, gm / am) : 0;

    let flux = 0;
    if (this.smoothMagsValid) {
      let diffSum = 0, magSum = 0;
      for (let k = 0; k < half; k++) {
        const s = 0.5 * this.smoothMags[k] + 0.5 * mags[k];
        diffSum += Math.abs(s - this.smoothMags[k]);
        magSum += s;
        this.smoothMags[k] = s;
      }
      flux = magSum > 1e-6 ? Math.min(1, diffSum / magSum) : 0;
    } else {
      for (let k = 0; k < half; k++) this.smoothMags[k] = mags[k];
      this.smoothMagsValid = true;
    }

    const [pitchHz, pitchConfidence] = this.detectPitch();
    return { rms, db, centroidHz, flatness, flux, zcr, pitchHz, pitchConfidence };
  }

  /// YIN による F0 推定 (MacTuner 移植, 2026-06-13)。
  /// 旧・正規化自己相関 (95–800Hz) を置換: 窓 2048 のリングで ~45Hz–2000Hz。
  /// CMND しきい値 0.15 + 谷歩き + 放物線補間。confidence = 1 - cmnd 最小値。
  detectPitch() {
    const W = this.yinWindowSize;
    if (this.pitchRingFill < W) return [0, 0];
    const sr = this.sampleRate;
    const x = this.pitchRing;
    const half = W >> 1;
    const minTau = Math.max(2, Math.floor(sr / 2000));
    const maxTau = Math.min(half - 2, Math.floor(sr / 45));
    if (minTau >= maxTau) return [0, 0];

    // CMND: cmnd[tau] = d(tau) * tau / Σ d(1..tau)
    const cmnd = new Float64Array(maxTau + 2);
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      let sum = 0;
      for (let j = 0; j < half; j++) {
        const d = x[j] - x[j + tau];
        sum += d * d;
      }
      runningSum += sum;
      cmnd[tau] = runningSum > 0 ? (sum * tau) / runningSum : 1;
    }

    // しきい値を最初に割った谷を局所最小まで歩く
    const threshold = 0.15;
    let bestTau = -1;
    for (let tau = minTau; tau < maxTau; tau++) {
      if (cmnd[tau] < threshold) {
        let localMin = tau;
        while (localMin + 1 < maxTau && cmnd[localMin + 1] < cmnd[localMin]) localMin++;
        bestTau = localMin;
        break;
      }
    }
    // フォールバック: 全体最小 (確度不足なら棄却)
    if (bestTau === -1) {
      let minVal = Infinity;
      for (let t = minTau; t < maxTau; t++) {
        if (cmnd[t] < minVal) { minVal = cmnd[t]; bestTau = t; }
      }
      if (minVal > 0.4) return [0, 0];
    }
    if (bestTau <= 1 || bestTau > maxTau) return [0, 0];

    const conf = Math.max(0, 1 - cmnd[bestTau]);

    // 放物線補間
    const s0 = cmnd[bestTau - 1], s1 = cmnd[bestTau], s2 = cmnd[bestTau + 1];
    const denom = 2 * (s0 - 2 * s1 + s2);
    if (Math.abs(denom) <= 1e-10) return [sr / bestTau, conf];
    const betterTau = bestTau + (s0 - s2) / denom;
    if (betterTau <= 0) return [0, 0];
    return [sr / betterTau, conf];
  }
}
