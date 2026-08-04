# Changelog

このファイルの書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

日付は該当コミットの author date (JST 換算前の UTC 日付) です。
このファイルは v1.0.0 以前の履歴を git ログから再構成して起こしたため、
初期のエントリは粒度が粗くなっています。以降の変更はここに追記してください。

## [Unreleased]

### Added

- `LICENSE` (MIT)。README がライセンスを宣言しているのに実体がなく、GitHub の
  ライセンス検出も効いていなかった状態を解消。
- `CONTRIBUTING.md` — パイプライン 5 段の入出力契約表と、踏みやすい地雷を明文化。
- `SECURITY.md` — 脆弱性の非公開報告手順と、CI Secret / LLM 出力 / ffmpeg 引数という
  攻撃面の整理。
- `CHANGELOG.md` (このファイル)。
- `bun test` による最初のユニットテスト群 (`tests/`)。純粋関数のみを対象とし、
  ネットワーク・ffmpeg・edge-tts には触れない。
- CI ワークフロー `ci.yml` — push / PR で構文チェックとテストを実行。
- `dependabot.yml` — npm と github-actions を週次で更新。
- CodeQL ワークフロー — push / PR / 週次で JavaScript を静的解析。

### Added (追補)

- **型チェックを導入した (`jsconfig.json` + `checkJs`)。** VAIZ にはこれまで型検査が
  一切なく、型の間違いは実行するまで分からなかった。TypeScript へは移していない —
  スクリプトは Bun から直接実行されるので、ビルド段を増やすとパイプラインの
  壊れどころが増えるだけ。JSDoc ベースの検査だけを掛けており、
  **実行されるコードは 1 バイトも変わらない**。`bun run typecheck` / CI に追加。

- **外部 API の応答形を JSDoc の typedef として明文化した。** これまで
  `await res.json()` の戻りは全て型なし (`unknown`) のまま各所へ流れていた。
  Linear GraphQL の封筒、OpenRouter のモデル一覧とチャット応答
  （モデル側エラーが HTTP 200 + `error` で返る件を含む）、
  Cloudflare Workers AI の画像/テキスト応答、GitHub の Release とアセット。
  パイプラインが外部サービスの何に依存しているかが型として残る。

### Fixed (追補)

- `images.mjs` の `err.status` — 素の `Error` に無いプロパティを生やしていた。
  `HttpError` (`Error & { status?: number }`) として明示。
  `isRetryable` の引数も、status を持つ HTTP 失敗と持たない fetch レベルの
  ネットワーク断の union として正確に型付けした。
- `plan.mjs` の `new Date(a) - new Date(b)` を `.getTime()` 差分に変更。
  実行時の挙動は同じ（`Date` は算術で `valueOf()` に落ちる）だが、
  型としては不正な演算だった。

### Changed

- `images.mjs` / `render.mjs` / `tts.mjs` / `publish.mjs` / `notify-failure.mjs` の
  `main()` 呼び出しを `if (import.meta.main)` で囲い、純粋関数を named export した。
  エントリポイントとして実行したときの挙動は従来どおり (`plan.mjs` が既に採っていた
  形に揃えただけ)。テストから import できるようにするための変更。

## [1.0.0] — 2026-08-04

Genesis Vault からの動画ブリーフ供給を受け口として確立し、パイプラインが
無人で一周するようになった時点。

### Added

- Genesis Vault が記事から起こした動画ブリーフを Linear 経由で受け取る導線
  (`repository_dispatch: video-brief-ready`)。上流にトークンがなくても
  cron が同じ Issue を拾うため、これは高速化であって前提ではない。
- 生成した動画ファイル本体を GitHub Release に加えて Linear の Issue にも添付。

### Fixed

- ffmpeg を自前で導入 (ubuntu-24.04 ランナーからプリインストールが外れたため)。
- OpenRouter の無料モデルを実行時に探索するよう変更。ハードコードした slug は
  予告なく有料化・削除されるため必ず腐る。
- 動画生成ループが実際に最後まで通るよう一連の修正。

## [0.1.0] — 2026-08-02

### Added

- 無料枠のみで構成した動画生成ループ一式:
  Linear Issue の claim → プラン生成 (OpenRouter / Cloudflare Workers AI フォールバック)
  → 画像生成 → edge-tts による音声合成 → ffmpeg レンダリング → GitHub Release への公開。
