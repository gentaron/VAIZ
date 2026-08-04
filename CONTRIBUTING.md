# CONTRIBUTING — VAIZ

VAIZ は Linear の Issue を 1 件 claim して 1 本の縦型動画を吐き出す、5 段のバッチパイプラインです。
各段は独立したスクリプトで、`out/` 配下のファイルを介してのみつながっています。

貢献するうえで最も重要なのはこの一点です:

> **`out/` に置くファイルの形が段と段の契約であり、それを壊す変更は「壊れていない」ように見えて壊れる。**

---

## 開発環境

```bash
bun install                   # 依存 (zod のみ)
pip install edge-tts          # TTS
# ffmpeg と日本語フォント (Noto Sans CJK) が PATH に必要
```

Node ではなく **Bun** で動かしてください。スクリプトは `import.meta.main` でエントリ判定しており、
これは Bun と Node 24+ でのみ真になります。

## パイプラインの段と契約

| 段 | コマンド | 読む | 書く |
|---|---|---|---|
| 1. plan | `bun run video:plan` | Linear Issue | `out/claim.json`, `out/plan.json` |
| 2. images | `bun run video:images` | `out/plan.json` | `out/img/NN.{png,jpg,webp}` |
| 3. tts | `bun run video:tts` | `out/plan.json` | `out/audio/NN.mp3`, `out/timing.json` |
| 4. render | `bun run video:render` | `out/plan.json`, `out/timing.json`, `out/img/`, `out/audio/` | `out/video.mp4` |
| 5. publish | `bun run video:publish` | `out/video.mp4`, `out/claim.json` | GitHub Release, Linear コメント |

`out/plan.json` の構造は `scripts/video/plan.mjs` の `PlanSchema` (zod) が正本です。
スキーマを変えるときは **下流 4 段すべて** を確認してください。型は実行時にしか検査されません。

## テスト

```bash
bun test
```

テストは純粋関数だけを対象にしています。ネットワーク (Linear / OpenRouter / Cloudflare)、
ffmpeg、edge-tts を叩くテストは書きません — CI で 30 分のタイムアウトを食い潰し、
外部サービスの都合で赤くなるからです。

**新しいロジックを足すときは、副作用のある関数から純粋関数を切り出してテストしてください。**
たとえば `wrapJapanese` / `assTime` / `buildTimeline` (render.mjs)、`extensionFor` / `isRetryable`
(images.mjs) はこの方針で切り出されています。

各スクリプトの `main()` は `if (import.meta.main)` で囲まれています。**この囲いを外さないでください** —
外すと import した瞬間にパイプラインが走り出し、テストが Linear の Issue を claim します。

## コミット

Conventional Commits を使います。

```
feat: シーン間のクロスフェード時間を可変にする
fix: ASS 字幕のエスケープが波括弧を落としていた
docs: パイプライン契約表を追記
test: wrapJapanese の全角/半角混在ケースを追加
chore: dependabot の対象に github-actions を追加
```

## 変更時に踏みやすい地雷

- **無料モデルの slug は腐る。** OpenRouter の無料モデルは予告なく有料化・削除されます。
  ハードコードせず、`discoverFreeModels()` の動的探索と Cloudflare Workers AI フォールバックを
  経由させてください。
- **edge-tts は 403 を返すことがある。** データセンター IP が弾かれるケースです。
  無音で先に進めず、明示的に失敗させて Linear に通知する現在の挙動を維持してください。
- **ffmpeg のフィルタ式は文字列連結で組み立てている。** 引用符・カンマ・コロンのエスケープを
  壊すと、エラーではなく「見た目が微妙に違う動画」が出ます。変更したら必ず実物を再生して確認を。
- **`concurrency: video-loop` は `cancel-in-progress: false`。** レンダリング中のジョブを
  途中で殺さないためです。true にしないでください。

## Secrets

CI は 4 つの Secret を使います: `LINEAR_API_KEY`, `OPENROUTER_API_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`。
ログや `out/` に値を出さないこと。PR に `.env` を含めないこと。

脆弱性の報告は [SECURITY.md](SECURITY.md) を参照してください。
