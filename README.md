# VAIZ — 完全無料の動画生成ループ

Linear から企画を自動で取得し、テキスト→画像→音声→動画を経て GitHub Release に公開するパイプライン。追加課金 API は一切使わない。

## アーキテクチャ

```
Genesis Vault (gentaron/genesisvault)
  │  記事を生成 → VE-009 Runa が動画ブリーフに変換
  │  → Linear に Todo + agent-ready で起票
  ▼
Linear Issue (agent-ready, Todo)
  │
  ▼ plan.mjs — Issue を claim して OpenRouter 無料モデルで動画プラン JSON 生成
  │  out/claim.json, out/plan.json
  ▼ images.mjs — Cloudflare Workers AI (Flux 1 Schnell) で画像生成
  │  out/img/{0..N}.jpg
  ▼ tts.mjs — edge-tts で日本語音声生成
  │  out/audio/{0..N}.wav + out/timing.json
  ▼ render.mjs — ffmpeg で動画合成 (Ken Burns, xfade, ASS 字幕)
  │  out/final.mp4
  ▼ publish.mjs — GitHub Release (draft) + Linear に動画本体を添付 → In Review
```

Issue の供給元は 2 つあり、VAIZ から見ると区別がない。

| 供給元 | 起票 | 頻度 |
|--------|------|------|
| Genesis Vault の日次パイプライン | VE-009 Runa が公開記事から自動生成 | 毎日 11:30 UTC 前後 |
| 人間 | Linear で直接書く（GEN-6 / GEN-7 がその例） | 随時 |

どちらも「Todo + `agent-ready` + GEN-6/GEN-7 と同じ見出し構成」という
1 つの契約を満たしていればよく、`plan.mjs` は本文をそのまま企画素材として読む。
上流を増やしても VAIZ 側の変更は要らない。

手で書く場合は、本文に **「VAIZ の video-loop がこの本文をそのまま企画素材として読む」**
の 1 行を残しておくこと。Todo から拾うだけならこの行は無くても動くが、
Todo より先へ動かされた Issue の救済（後述）はこの印を目印にしている。

## 生成物の受け取り先

| 場所 | 中身 | 備考 |
|------|------|------|
| Linear Issue の添付 + コメント | final.mp4 本体 | その場で再生できる。通常はここ |
| GitHub Releases (draft) | final.mp4 | 書き込み権限のある人にのみ表示。Tags には出ない |
| Actions の Artifacts | `out/` 丸ごと | publish が失敗したときの回収用 |

draft release は権限のある人しか見られず Tags にも出ないため、`publish.mjs` は
動画ファイルの実体を Linear にもアップロードする。手順は 3 段階。

1. `fileUpload` ミューテーションで署名付き URL を発行
2. その URL へ PUT で生バイトを送る（Google Cloud Storage 直送）
3. `attachmentCreate` で `assetUrl` を Issue に紐付ける

署名付き URL の**有効期限は 60 秒**なので、発行したら即 PUT すること。返って
きたヘッダは 1 つでも欠けると 403 になるので全部そのまま送る。ヘッダの組み立てに
素のオブジェクトを使うと `Content-Type` と `content-type` が別キーになり
content-type が二重に飛ぶため、`Headers` で正規化している。
アップロード上限は 2GB。Linear 側が失敗しても Release は既にあるので中断しない。

## 入出力の契約 (疎結合設計)

各スクリプトは `out/` 配下のファイルだけで受け渡しする。これにより、将来 `render.mjs` を Veo / Runway 等に差し替える場合でも、`plan.json` + `img/` + `audio/` という入力契約を満たす任意のプロセスに置き換え可能。

| ファイル | 形式 | 生成元 | 消費先 |
|----------|------|--------|--------|
| `out/claim.json` | JSON `{id, identifier, title}` | plan.mjs (claim 直後) | notify-failure.mjs |
| `out/plan.json` | JSON | plan.mjs | images.mjs, tts.mjs, render.mjs, publish.mjs |
| `out/img/{i}.jpg` | JPEG / PNG / WebP (任意サイズ) | images.mjs | render.mjs |
| `out/audio/{i}.wav` | WAV PCM 24kHz mono | tts.mjs | render.mjs |
| `out/timing.json` | JSON `[{index, file, duration}]` | tts.mjs | render.mjs |
| `out/final.mp4` | H.264 / yuv420p / 1080x1920 / 30fps | render.mjs | publish.mjs |

`claim.json` を `plan.json` より先に書くのは、プラン生成でコケたときにも「どの Issue を掴んでいたか」を失敗通知に伝えるため。

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
- 合計秒数: 45〜60 が目標（35〜80 までは通す。実尺は TTS の実測値で決まるので `seconds` は目安）
- 各シーン秒数: 3〜15

## 尺の決まり方

`seconds` は使わず、`timing.json` の実測値だけでタイムラインを組む。字幕・音声・映像はすべてこの 1 つの計算結果を共有するので、ずれない。

```
clip[i] の尺       = 0.3s + narration[i] の実測尺 + 0.3s
clip[i] の開始位置 = clip[i-1] の開始位置 + clip[i-1] の尺 - 0.4s (xfade の重なり)
音声[i] の開始位置 = clip[i] の開始位置 + 0.3s
字幕[i] の表示区間 = 音声[i] と完全に一致
```

## 必要 Secrets

| Secret | 用途 | 取得先 |
|--------|------|--------|
| `LINEAR_API_KEY` | Linear から Issue を取得・更新 | Linear > Settings > API > Personal API keys |
| `OPENROUTER_API_KEY` | 無料モデルで動画プラン生成 | https://openrouter.ai/keys |
| `CF_ACCOUNT_ID` | Cloudflare Workers AI で画像生成 | Cloudflare Dashboard > Workers & Pages |
| `CF_API_TOKEN` | 同上 | Cloudflare Dashboard > My Profile > API Tokens |

`GITHUB_TOKEN` は Actions が自動で渡すので設定不要。

### 任意の環境変数 / Repository variables

| 変数 | 既定値 | 用途 |
|------|--------|------|
| `LINEAR_TEAM_KEY` | `GEN` | 対象の Linear チーム |
| `OPENROUTER_MODELS` | (なし) | カンマ区切り。指定すると最優先で試す |
| `TTS_VOICE` | `ja-JP-NanamiNeural` | edge-tts の音声（男性なら `ja-JP-KeitaNeural`） |
| `TTS_RATE` | `+0%` | 読み上げ速度（例 `+10%`） |
| `CF_TEXT_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | OpenRouter 全滅時のフォールバック |

### モデルの選び方

無料モデルのスラッグは予告なく有料化されるので、一覧をハードコードしていない。
実行時に OpenRouter の `/api/v1/models`（認証不要）から prompt / completion 単価が
ゼロのモデルを拾い、文脈長の長い順に試す。

```
OPENROUTER_MODELS の指定  →  openrouter/free (オートルーター)
  →  実行時に見つけた無料モデル 上位6件  →  Cloudflare Workers AI
```

404 / 403 / 429 が返ったモデルは再試行せず次の候補へ送る（そのキーでは何度叩いても同じなので）。
全滅した場合のみ Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`) に落ちる。
CF は画像生成と同じ 1 日 10,000 neurons を食うので、あくまで最後の砦。

## ローカル実行

```bash
bun install
bun run video:plan      # → out/claim.json, out/plan.json
bun run video:images    # → out/img/
bun run video:tts       # → out/audio/ + out/timing.json
bun run video:render    # → out/final.mp4
bun run video:publish   # → GitHub Release (draft)
```

各スクリプトは単体で実行可能。前段の `out/` ファイルが必要。ffmpeg / ffprobe と日本語フォント (`fonts-noto-cjk`) が要る。

> ffmpeg は ubuntu-24.04 のランナーイメージから外されているので、ワークフローで `apt-get install ffmpeg` している。ubuntu-22.04 時代のプリインストール前提ではもう動かない。

`images.mjs` は生成済みの `out/img/{i}.*` を読み飛ばすので、途中で落ちても再実行で続きから走る。

## 企画ファイルから下書き動画を作る（Linear不要）

`infocollect`の`creative-brief` JSONを手元に保存し、`brief.goal`と`brief.audience`を埋めてから実行する。出典URLはHTTPSで指定する。**この経路は公開しない**。`out/`は実行前に空にしておく（既存ファイルがあればコマンドが停止する）。

```bash
bun run video:plan:brief brief.json  # out/plan.json。OpenRouterまたはCloudflareのテキストモデルを使う
bun run video:images                 # 画像生成にはCloudflareの認証情報が必要
bun run video:tts
bun run video:render                 # out/final.mp4
```

### PCに負荷をかけずGitHub Actionsで作る

レビューした`creative-brief` JSONをこの公開リポジトリの`briefs/名前.json`としてコミットし、Actionsの**VAIZ Brief Draft → Run workflow**で`brief_path`にそのパスを入れる。画像生成・音声合成・ffmpegはGitHubのランナーで動き、結果は実行ページの`brief-draft-*` Artifactから取得する。このワークフローはReleaseの作成、Linearへの送信、SNS公開を行わない。

初回の動作確認には同梱の`briefs/example.json`を`brief_path`に指定できる。実際の企画では別名のファイルを追加する。

`briefs/`のファイルは公開されるため、個人情報や秘密値は入れない。OpenRouterとCloudflareのキーはリポジトリのActions Secretsから読む。書き出した直後のInfoCollect JSONは`goal`と`audience`が空なので、編集してから実行する。

`video:publish`はLinear Issueがない下書きには使えない。完成した`out/final.mp4`を確認してから、別途公開方法を決める。モデル生成前にJSON形式・目的・対象視聴者を検証し、出典URLを`plan.json`に残す。既存の定時実行・Linear経路はそのまま使える。

## テスト

```bash
bun test
```

Bun 内蔵のテストランナーを使うので **追加依存はゼロ**。対象は純粋関数だけで、
Linear / OpenRouter / Cloudflare にも ffmpeg / edge-tts にも触らない。
そのため CI は Secret なしで数秒で完走する。

固定しているのは、壊れてもエラーにならず「微妙に違う動画」として出てくる箇所:

| 対象 | 何を固定しているか |
|---|---|
| `render.mjs` | タイムライン計算 (0.3s の無音余白 / 0.4s の xfade)、ASS の時刻書式、`{}` `\` の無害化、日本語の禁則処理付き折り返し、Ken Burns のズーム式 |
| `plan.mjs` | `PlanSchema` の境界 (シーン 6〜8、総尺 35〜80s、1 シーン 3〜15s)、フェンスや前置き付き応答からの JSON 抽出、モデル死活判定 |
| `images.mjs` | マジックバイトからの拡張子判定、429/5xx の再試行判定 |
| `publish.mjs` | GitHub API ヘッダの固定 (API バージョンの暗黙アップグレード防止) |

各スクリプトの `main()` は `if (import.meta.main)` で囲ってある。テストから import しても
パイプラインが走り出さないようにするためで、**この囲いを外すとテストが Linear の Issue を claim する**。

## GitHub Actions

- **cron**: 毎日 13:00 UTC 自動起動 (マレーシア時間 21:00 / 日本時間 22:00)
- **手動**: Actions タブ > VAIZ Video Loop > Run workflow
- **repository_dispatch (`video-brief-ready`)**: Genesis Vault がブリーフを
  Linear に積んだ直後に叩いてくる。上流に `VAIZ_DISPATCH_TOKEN`（このリポジトリへの
  `contents: write` を持つ PAT）が設定されていなければ飛んでこないだけで、
  同じ Issue を cron が拾う。**待ち時間を縮めるためのものであって、経路の前提ではない。**
- concurrency グループで多重起動を防止（`cancel-in-progress: false` — レンダリング中の実行は殺さない）
- どのステップで失敗しても `out/` を artifact に保存

### なぜ 13:00 UTC なのか（Todo は VAIZ 専用の待ち行列ではない）

Linear の Todo を漁るのは VAIZ だけではない。上流 Genesis Vault の
`linear-write.yml` が **21:00 UTC** に「最も古い Todo」を 1 件持っていく。
そちらはラベルで絞らないので、動画ブリーフも一緒に持っていってしまう。

以前 VAIZ は 22:00 UTC に走っていた。つまり毎晩、ブリーフが取られた後に
到着して「Todo に何も無い」で終わっていた。ブリーフが積まれるのは
`daily-post` (11:30 UTC) の 30 分ほど後なので、**13:00 UTC なら積まれた後・
取られる前**に入れる。

ただし時刻をずらしただけでは「先に取ったほうが勝ち」の競争でしかない。
そこで `plan.mjs` は Todo が空のとき、**動画がまだ届いていない動画ブリーフ**を
In Progress / In Review から拾い直す（下記）。

### 何を「まだやっていない仕事」とみなすか

| 判定 | 根拠 |
|---|---|
| 動画ブリーフか | 本文に `<!-- gv:source=… >` または「VAIZ の video-loop」がある |
| 動画が届いたか | `publish.mjs` が残す `<!-- vaiz:video -->` 入りのコメントがあるか |

state ではなくコメントで見るのは、state を書き換えるのが VAIZ 以外にも
いる（上流のワークフロー、Linear の GitHub 連携）ため。このコメントを
書くのは VAIZ だけなので、完了条件をここに置いてある。Backlog は救済対象に
入れない — あそこは「今はやらない」と人間が置いた棚だから。

### 失敗したときの扱い

| 失敗箇所 | Issue の行き先 |
|----------|----------------|
| プラン生成 (plan.mjs) | 自動で **claim 前の state** に戻す + 理由をコメント。次回の cron で再挑戦 |
| 画像 / 音声 / 描画 / 公開 | **In Progress** のまま + 実行ログをコメント |

Todo から拾ったものは Todo へ、In Progress / In Review から救済したものは
そこへ戻す。救済分を一律 Todo に落とすと、上流の writer にまた食われるため。

後段の失敗で戻さないのは、原因が直っていないのに毎晩リトライして無料枠を食い潰すのを避けるため。直したら手動で Run workflow する。

## 使用する無料サービス

| サービス | 用途 | ライセンス | コスト |
|----------|------|------------|--------|
| OpenRouter (無料モデル) | プラン生成 | — | 無料 |
| Cloudflare Workers AI (Flux 1 Schnell) | 画像生成 | Apache 2.0 | 無料枠内 |
| edge-tts | 日本語 TTS | GPL-3.0 (CLI) | 無料 / APIキー不要 |
| Cloudflare Workers AI (Llama 3.1 8B) | プラン生成のフォールバック | — | 無料枠内（画像と共用） |
| ffmpeg | 動画合成 | LGPL/GPL | 無料（apt で導入） |

### なぜ Kokoro を使っていないか

Kokoro v0.19 は英語専用モデルで、日本語の音素化ができない。voice に `ja-JP-*` を渡しても必ず失敗するため、実質 edge-tts フォールバックしか動いていなかった。日本語対応の Kokoro v1.0 は misaki[ja] (fugashi / unidic / pyopenjtalk) が必要で、CI で毎回 300MB 超を入れることになる。「完全無料 + CI で軽い」という前提では edge-tts が正解なので、Kokoro とそのモデルキャッシュは外した。

戻したくなった場合は `scripts/video/tts_helper.py` の `synthesize()` だけ差し替えればよい（`--text` / `--output` を受けて WAV を書き、秒数を stdout に出す、という契約は変わらない）。

### 既知のリスク

OpenRouter の無料枠は縮小傾向にある。2026-08 時点で deepseek / llama-3.3-70b / qwen-2.5-72b /
gemma-3-27b / mistral-small の `:free` はいずれも 404（有料版へ誘導）になっていた。
動的探索と Cloudflare フォールバックを入れてあるのはこのため。

edge-tts は Microsoft の公開エンドポイントを叩いているので、データセンター IP からのアクセスが 403 で弾かれることが稀にある。その場合 TTS ステップが明示的に失敗し、Linear に通知が飛ぶ（無音のまま先に進むことはない）。

Release は `draft: true` で作るため、コメントに載る Download URL はリポジトリへのアクセス権がないと開けない。

## ライセンス

[MIT](LICENSE) — 全文はリポジトリ直下の `LICENSE` を参照。

<!-- ecosystem:begin (自動生成: gentaron/infocollect の ecosystem/registry.json から。手で直さない) -->

## つながり

gentaron のリポジトリ群のうち **発信パイプライン** の一つ。完全無料の動画生成ループ。企画 → 画像 → 音声 → 動画。

- **受け取る**: [infocollect](https://github.com/gentaron/infocollect)（記事・ナレッジベース）、[genesisvault](https://github.com/gentaron/genesisvault)（記事）、[Gentarog](https://github.com/gentaron/Gentarog)（記事）、[Mathematical-Physics-Lab-](https://github.com/gentaron/Mathematical-Physics-Lab-)（研究ノート）、[QAIZ](https://github.com/gentaron/QAIZ)（相場の地形）
- **同じ島**: [IDEAZ](https://github.com/gentaron/IDEAZ)、[SAIZ](https://github.com/gentaron/SAIZ)、[genimage](https://github.com/gentaron/genimage)、[seo](https://github.com/gentaron/seo)

全体の地図 → [ecosystem](https://github.com/gentaron/infocollect/blob/HEAD/ecosystem/README.md)

<!-- ecosystem:end -->
