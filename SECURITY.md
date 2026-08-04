# Security Policy — VAIZ

## サポート範囲

`main` ブランチの最新コミットのみをサポートします。過去のタグへのバックポートは行いません。

## 脆弱性の報告

**公開 Issue に書かないでください。**

GitHub の [Security Advisories](https://github.com/gentaron/VAIZ/security/advisories/new)
から非公開で報告してください。72 時間以内に一次応答します。

報告に含めてほしいもの:

- 再現手順、または影響を受けるスクリプトと行
- 想定される影響 (Secret の漏洩 / 任意コード実行 / サプライチェーン汚染 など)
- 判明していれば影響バージョン (コミット SHA)

## このリポジトリの攻撃面

VAIZ は CI から外部 API を叩き、生成物を GitHub Release に上げるパイプラインです。
以下が主な攻撃面であることを認識したうえで報告・レビューしてください。

| 攻撃面 | 内容 |
|---|---|
| CI Secrets | `LINEAR_API_KEY` / `OPENROUTER_API_KEY` / `CLOUDFLARE_*` の 4 つ。ログ・成果物への漏出が最大のリスク |
| LLM 出力 | Linear Issue 本文 → LLM → `plan.json` → **ffmpeg のコマンド引数**。プロンプトインジェクション経由でのコマンド組み立て汚染に注意 |
| 外部エンドポイント | OpenRouter / Linear / Cloudflare / Microsoft edge-tts。いずれも応答を信用しすぎない |
| 依存 | `zod` のみ (実行時)。Dependabot が週次で更新 PR を出す |

とくに **LLM の出力は信頼できない入力** として扱ってください。`plan.json` は zod で
検証してから使いますが、検証を通った文字列がそのまま ffmpeg のフィルタ式や字幕に
入る経路があります。ここを緩める変更は脆弱性になり得ます。

## 適用外

- 生成された動画の内容そのもの (品質・事実誤り) は脆弱性として扱いません
- レート制限や無料枠の枯渇による失敗は既知の運用上の制約です
- Release が `draft: true` のためダウンロード URL に権限が要る件は仕様です
