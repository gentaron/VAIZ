# VAIZ — 完全無料の動画生成ループ

Linear から企画を自動で取得し、テキスト→画像→音声→動画を経て GitHub Release に公開するパイプライン。追加課金 API は一切使わない。

## アーキテクチャ

```
Linear Issue (agent-ready, Todo)
  │
  ▼ plan.mjs — OpenRouter 無料モデルで動画プラン JSON 生成
  │  out/plan.json
  ▼ images.mjs — Cloudflare Workers AI (Flux 1 Schnell) で画像生成
  │  out/img/{0..N}.png
  ▼ tts.mjs — Kokoro / edge-tts で日本語音声生成
  │  out/audio/{0..N}.wav + out/timing.json
  ▼ render.mjs — ffmpeg で動画合成 (Ken Burns, xfade, ASS 字幕)
  │  out/final.mp4
  ▼ publish.mjs — GitHub Release (draft) + Linear にコメント
```

## 入出力の契約 (疎結合設計)

各スクリプトは `out/` 配下のファイルだけで受け渡しする。これにより、将来 `render.mjs` を Veo / Runway 等に差し替える場合でも、`plan.json` + `img/` + `audio/` という入力契約を満たす任意のプロセスに置き換え可能。

| ファイル | 形式 | 生成元 | 消費先 |
|----------|------|--------|--------|
| `out/plan.json` | JSON | plan.mjs | images.mjs, tts.mjs, render.mjs, publish.mjs |
| `out/img/{i}.png` | PNG (任意サイズ) | images.mjs | render.mjs |
| `out/audio/{i}.wav` | WAV PCM | tts.mjs | render.mjs |
| `out/timing.json` | JSON `[{index, file, duration}]` | tts.mjs | render.mjs |
| `out/final.mp4` | H.264 / yuv420p / 1080x1920 / 30fps | render.mjs | publish.mjs |

### plan.json スキーマ

```json
{
  "title": "動画のタイトル",
  "hook": "フック文",
  "scenes": [
    {
      "narration": "日本語のナレーションテキスト",
      "image_prompt": "English prompt for image generation",
      "seconds": 7
    }
  ],
  "hashtags": ["#tag1", "#tag2"],
  "_issue": { "id": "Linear Issue ID", "identifier": "GEN-123" }
}
```

- シーン数: 6〜8
- 合計秒数: 45〜60
- 各シーン秒数: 3〜15

## 必要 Secrets

| Secret | 用途 | 取得先 |
|--------|------|--------|
| `LINEAR_API_KEY` | Linear から Issue を取得・更新 | Linear > Settings > API > Personal API keys |
| `OPENROUTER_API_KEY` | 無料モデルで動画プラン生成 | https://openrouter.ai/keys |
| `CF_ACCOUNT_ID` | Cloudflare Workers AI で画像生成 | Cloudflare Dashboard > Workers & Pages |
| `CF_API_TOKEN` | 同上 | Cloudflare Dashboard > My Profile > API Tokens |

## ローカル実行

```bash
bun install
bun run video:plan      # → out/plan.json
bun run video:images    # → out/img/
bun run video:tts       # → out/audio/ + out/timing.json
bun run video:render    # → out/final.mp4
bun run video:publish   # → GitHub Release
```

各スクリプトは単体で実行可能。前段の `out/` ファイルが必要。

## GitHub Actions

- **cron**: 毎日 22:00 UTC 自動起動
- **手動**: Actions タブ > VAIZ Video Loop > Run workflow
- concurrency グループで多重起動を防止
- どのステップで失敗しても `out/` を artifact に保存

## 使用する無料サービス

| サービス | 用途 | ライセンス | コスト |
|----------|------|------------|--------|
| OpenRouter (deepseek-chat-v3-0324:free) | プラン生成 | — | 無料 |
| Cloudflare Workers AI (Flux 1 Schnell) | 画像生成 | Apache 2.0 | 無料枠内 |
| Kokoro-onnx | 日本語 TTS (第一候補) | Apache 2.0 | CPU 推論 / 無料 |
| edge-tts | 日本語 TTS (フォールバック) | MIT | 無料 |

## ライセンス

MIT
