# Ear Onomatopian (web)

耳のオノマトピアン — 聴いた音を、ことばで返す。

マイクが拾った音を、音声認識ではなく**「音の形」** — 音色・アタック・ピッチの動き・長さ・反復 — として聴き取り、日本語のオノマトペに変換して喋り返す Web アプリ。手を叩くと「カッ」、鈴を振ると「チリチリ」、低く唸ると「ゴーー」。

macOS / iOS ネイティブ版 ([Iceface Onomatopian Sound](https://github.com/Iceface-microtonal) / PTS シリーズの Ear 派生) の JavaScript 移植です。

## 遊び方

HTTPS (または localhost) で開いて「はじめる」→ マイクを許可 → 音を鳴らすだけ。
マイク無しでも「テスト音」ボタンでパイプラインを試せます。

ローカル実行:

```bash
python3 -m http.server 8765
# → http://localhost:8765/ を開く
```

## 仕組み

```
マイク → 音響解析 → 4軸写像 → 語生成 (決定的) → 録音 CV サンプル合成 → 発声
         (analyzer)   (mapper)    (core)              (renderer)
```

- **音響解析** — RMS / スペクトル重心・平坦度・流量 (FFT) / 正規化自己相関 F0 /
  ピッチ輪郭 8 点 / 再アタック検出 / スウェル→谷→スウェル検出
- **4 軸写像** — 大小・鋭鈍・粗滑・明暗の音象徴ベクトルへ
- **語生成** — 軸から決定的 seed を導き、CV 列を生成。
  **同じ音は、いつ聴かせても同じ語になります**
  (RNG を BigInt で Swift と bit 単位一致させており、ネイティブ版とも同じ語が出ます)
- **語の形のものまね** — 長さ→モーラ数、ピッチ→声の高さ、旋律→歌い返し、
  変化の速さ→刻み、アタック→立ち上がり、音量→声量、余韻→「ー」、
  スウェル→谷→スウェル→**順+逆再生のパリンドローム** (ポワーン ⇄ ンーワポ)

すべてローカル処理。録音は保存も送信もされません。

## 開発

```bash
node test/test.mjs   # 純ロジック部のテスト (Swift 版とのパリティ検証を含む)
```

- `js/core.js` — 4 軸 → CV 列の生成 (PTS コア)、カタカナ表記
- `js/analyzer.js` — 音イベント解析 (Web Audio 非依存の純ロジック)
- `js/mapper.js` / `js/shaper.js` — 特徴 → 4 軸 / 語の形
- `js/renderer.js` — CV サンプル → 合成バッファ
- `js/app.js` — Web Audio 接続と UI
- `audio/` — 録音 CV サンプル 110 個 (PTS 共通音源)

---
文字のアクアリウム・Hand Onomatopian と同じく、Iceface Onomatopian Sound (PTS) シリーズの派生作品。
