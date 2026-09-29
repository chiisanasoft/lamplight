# 拡張機能開発ガイド

Lamplight の拡張機能は、第三者も作成・配布できます。本書は拡張機能の開発者向けの仕様書です（拡張機能 API バージョン `1`）。

- 拡張機能は `.lamplightext` 形式のファイル（実体は `.tar.gz`）です。利用者は、設定画面の「拡張機能」タブにある「ファイルから追加…」でインストールします。
- インストール時に、Lamplight はパッケージ内の全ファイルを `CHECKSUMS` と照合します。
- Lamplight の開発元が署名したものは「公式」、それ以外は「開発元未確認」と表示され、利用者の確認後にインストールされます。
- 拡張機能は利用者の権限で動作するプログラムです。外部への送信を行う場合は、目的と送信先を利用者に明示してください。

## 拡張機能の種別

| `type` | 機能 |
| --- | --- |
| `ollama-proxy` | LibreChat と Ollama の間に入る OpenAI 互換の HTTP プロキシ。受信した要求を加工して Ollama に転送し、応答を返す。同時に有効化できるのは 1 つのみ |

`ollama-proxy` 型では、次の機能も提供できます。

- `ocrService`: Mistral OCR 互換の API を提供し、LibreChat の「テキストとしてアップロード」で文書を読み取る
- `downloadPaths`: 拡張機能が返すリンクのうち、指定したパスで始まるものをダウンロードとして保存させる

## パッケージ構成

```
my-extension/
├── manifest.json
├── server.js          # manifest.main（エントリーポイント）
└── node_modules/      # 実行時の依存（必要な場合）
```

ネイティブモジュールを含む場合は、OS・CPU ごとにパッケージを作成し、`platforms` には対応する値のみを記載します。シンボリックリンクは含められません。

## マニフェスト仕様（manifest.json）

```json
{
  "id": "my-proxy",
  "name": "My プロキシ",
  "version": "1.0.0",
  "description": "設定画面の一覧に表示する説明",
  "lamplightApi": 1,
  "type": "ollama-proxy",
  "main": "server.js",
  "platforms": ["darwin-arm64", "linux-x64"],
  "author": "作成者名",
  "homepage": "https://example.com/my-proxy",
  "license": "MIT",
  "requires": { "ollamaModels": ["qwen3.5:9b"] },
  "settings": [
    { "key": "model", "label": "使用するモデル", "type": "ollama-model", "default": "", "description": "設定画面に表示する補足" },
    { "key": "prefix", "label": "前置き", "type": "text", "default": "" }
  ]
}
```

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `id` | ○ | 英小文字・数字・`-`（41 文字以内）。インストール先のフォルダ名となり、同じ `id` のものは上書きされる |
| `name`・`version`・`description` | ○ | 表示名、`x.y.z` 形式のバージョン、説明 |
| `lamplightApi` | ○ | `1` |
| `type` | ○ | `ollama-proxy` |
| `main` | ○ | エントリースクリプト（パッケージのルートからの相対パス） |
| `platforms` | ○ | 対応する `<OS>-<CPU>`（`darwin-arm64`・`darwin-x64`・`linux-x64`・`linux-arm64`） |
| `author`・`homepage`・`license` | | 設定画面の一覧に表示する。`homepage` は `https://` のみ |
| `requires.ollamaModels` | | 必要な Ollama のモデル。未取得の場合、設定画面に `ollama pull` を案内する |
| `settings` | | 利用者が設定画面で変更できる値。`type` は `text` または `ollama-model`（インストール済みモデルからの選択） |
| `ocrService` | | `{ "basePath": "/v1", "model": "..." }`。Mistral OCR 互換 API の配置パス |
| `downloadPaths` | | ダウンロードとして扱うパス（例: `["/exports/"]`） |

## 実行環境

Lamplight は内蔵サーバーの起動前に、Electron 内蔵の Node.js（Node.js 24 相当）でエントリースクリプトを子プロセスとして実行します。

- 設定は環境変数 `LAMPLIGHT_EXT_CONFIG`（JSON）で渡されます。

  ```json
  {
    "port": 51234,
    "upstream": "http://127.0.0.1:11434",
    "dataDir": "/…/extension-data/my-proxy",
    "settings": { "model": "qwen3.5:9b", "prefix": "" },
    "token": "起動ごとに変わる秘密の値"
  }
  ```

- `127.0.0.1:<port>` で待ち受け、準備完了後に `process.send({ ready: true })` を送信します。20 秒以内に送信されない場合、起動失敗として扱います。
- LibreChat は、Ollama の代わりに `http://127.0.0.1:<port>/v1/` へ OpenAI 互換の要求（`/v1/chat/completions` など）を送信します。モデル一覧は `/api/tags` と `/v1/models` で取得します。処理対象外の要求は `upstream`（Ollama）へそのまま転送してください。
- 書き込み可能な場所は `dataDir` のみです（拡張機能のフォルダはインストール時の照合対象のため）。
- 標準出力と標準エラー出力は、Lamplight のログフォルダの `ext-<id>.log` に保存されます。
- `ocrService` を提供する場合、LibreChat は `Authorization: Bearer <token>` を付与して呼び出します。トークンを検証してください。

最小構成の例:

```js
// server.js
const http = require("node:http");
const cfg = JSON.parse(process.env.LAMPLIGHT_EXT_CONFIG);

http.createServer(async (req, res) => {
  // 要求の加工はここで行う。この例ではそのまま Ollama に転送する
  const upstream = await fetch(cfg.upstream + req.url, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "application/json" },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
    duplex: "half",
  });
  // fetch() は本文を復号済みのため、元の長さ・圧縮形式のヘッダーは転送しない
  const skip = new Set(["content-encoding", "content-length", "transfer-encoding"]);
  res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !skip.has(k))));
  for await (const chunk of upstream.body ?? []) res.write(chunk);
  res.end();
}).listen(cfg.port, "127.0.0.1", () => process.send?.({ ready: true }));
```

## パッケージ作成

[`scripts/pack-extension.mjs`](../scripts/pack-extension.mjs) は Node.js のみで動作するため、各自のプロジェクトにコピーして使用できます。

```sh
node pack-extension.mjs my-extension                         # 署名なし
node pack-extension.mjs my-extension --sign my-key.pem       # 独自の Ed25519 鍵で署名
```

`CHECKSUMS`（全ファイルの SHA-256）を含むパッケージが作成されます。インストール時に、ファイルの追加・変更・欠落、またはシンボリックリンクが検出された場合は拒否されます。

「公式」として扱われるのは、Lamplight の開発元の鍵で署名されたパッケージのみです。独自の鍵による署名は、現時点では「開発元未確認」として扱われます。

## 開発時の補足

- `LAMPLIGHT_EXT_CONFIG` を設定すれば、Lamplight を介さず単体で起動できます（`node server.js`）。
- インストール済みの拡張機能は、Lamplight のデータ保存先の `extensions/<id>` に配置されます（macOS: `~/Library/Application Support/Lamplight/extensions`、Linux: `~/.config/Lamplight/extensions`）。更新する場合は、`version` を上げたパッケージを再度追加します。
- 参考実装: 本リポジトリの `extensions/ocr`（PDF の画像化、OCR、Mistral OCR 互換 API、Excel 出力）
