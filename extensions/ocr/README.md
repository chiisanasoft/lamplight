# OCR 拡張機能

LibreChat と Ollama の間で動作し、PDF をローカル LLM で扱えるようにする拡張機能です（[librechat-ocr-bridge](https://github.com/chiisanasoft/librechat-ocr-bridge) の Node.js 版）。

## 処理内容

| 送信先のモデル | 処理 |
| --- | --- |
| OCR モデル（`glm-ocr`） | PDF をページ単位で画像化して読み取り、表を Markdown の表と Excel に変換する |
| 画像入力に対応したモデル | PDF のページ画像を渡す |
| その他のモデル | PDF の文字情報を渡す。スキャンしたページは事前に `glm-ocr` で読み取る |
| `ocr-format` | 全ページの表を結合し、指定した列に整形して Excel（整形済み・確認リスト・OCR 原本）で出力する |
| テキストとしてアップロード | LibreChat の OCR サービス（Mistral OCR 互換 API: `/v1/files`・`/v1/ocr`）として動作する。文字情報を含むページはそのまま、スキャンしたページは `glm-ocr` で読み取る |

## 設定項目

Lamplight の設定画面の「拡張機能」タブで設定します。

| 項目 | 内容 |
| --- | --- |
| OCR→整形（ocr-format）に使うモデル | 選択すると、モデル一覧に `ocr-format` が表示される |
| 整形後の列（カンマ区切り） | 整形後の列を指定する。チャットで `列: 日付, 氏名` のように記述すると、その回のみ変更できる |

## 動作要件

- Ollama に `glm-ocr` が取得済みであること（`ollama pull glm-ocr`）

## 依存ライブラリ

pdf.js（Apache-2.0）、@napi-rs/canvas・exceljs・htmlparser2（MIT）

## ビルド

リポジトリのルートで `npm run build:ext` を実行します。
