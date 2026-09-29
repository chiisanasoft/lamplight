<p align="center">
  <img src="brand/icon.svg" width="120" height="120" alt="Lamplight のロゴ">
</p>

<h1 align="center">Lamplight</h1>

[LibreChat](https://github.com/danny-avila/LibreChat) を基盤としたデスクトップアプリケーションです。インストールのみで利用でき、Docker は不要です。

LibreChat のサーバーをアプリケーションに内蔵し、アプリケーションの起動・終了に合わせて動作させます（**内蔵サーバー**モード）。既存の LibreChat（Docker 環境や別のマシン）に接続する**外部サーバー**モードにも対応します。LibreChat の画面をアプリケーション内に表示し、クイック入力・メニューバー・通知などのネイティブ機能を追加します。

> Lamplight は LibreChat の公式アプリケーションではなく、LibreChat プロジェクトとの提携関係はありません。

## 機能一覧

| 機能 | 概要 |
| --- | --- |
| 内蔵サーバー | LibreChat サーバー（v0.8.7）を内蔵し、アプリケーションと連動して起動・停止する。会話は MongoDB に保存し、ローカル用アカウントで自動的にサインインする |
| 拡張機能 | `.lamplightext` 形式のパッケージで機能を追加する。第三者による作成・配布が可能（仕様: [docs/EXTENSIONS.md](docs/EXTENSIONS.md)）。開発元の署名があるものは「公式」と表示する。開発元の拡張機能として OCR（PDF の読み取り、表の Excel 出力、OCR 結果の整形 `ocr-format`）を提供 |
| メインウィンドウ | LibreChat を専用ウィンドウで表示する。ログイン状態とウィンドウ位置を保持し、外部リンクは既定のブラウザで開く |
| クイック入力 | `Alt+Space`（macOS では `⌥Space`）で入力欄を表示し、選択したモデルで新規チャットを開始する |
| メニューバー / トレイ | 新規チャット、お気に入りモデルでのチャット開始、サーバー接続状態の確認 |
| 応答完了通知 | ウィンドウが背面にあるとき、応答の完了を OS の通知で知らせる |
| 接続エラー画面 | LibreChat に接続できない場合に、原因と再接続・接続先変更の操作を表示する |

## 対応環境

| OS | 対応状況 | 配布形式 |
| --- | --- | --- |
| macOS（Apple シリコン） | 対応（内蔵サーバー・外部サーバー） | `.dmg` |
| Linux | 未対応 | — |
| Windows | 未対応 | — |

## 内蔵サーバー構成

| 項目 | 内容 |
| --- | --- |
| LibreChat サーバー | Electron 内蔵の Node.js で子プロセスとして起動する。待ち受けは `127.0.0.1` のみ。ポートは初回起動時に決定し、以降も同じポートを使用する |
| MongoDB | MongoDB Community Server は同梱しない。初回起動時に利用者の同意を得て公式サイトから取得し、SHA-256 で検証する |
| アカウント | 初回起動時にローカル用アカウントを作成し、以降は起動時に自動でサインインする。新規登録は無効 |
| 秘密情報 | 暗号鍵などを OS のキーチェーン（`safeStorage`）で暗号化して保存する。キーチェーンの項目が失われた場合は、利用者の確認を経て鍵を再生成し、ローカル用アカウントを復旧する（会話は保持、保存済みの API キーは再入力が必要） |
| アップデート | GitHub Releases から更新を自動で確認・取得する（設定で無効化可能） |
| データ保存先 | `~/Library/Application Support/Lamplight/`（MongoDB のデータ、アップロード、画像、ログ、設定） |
| サーバー設定 | LibreChat の既定値（`.env.example`）を基に構成する。OpenAI・Anthropic・Google は、チャット画面のモデル選択にある歯車アイコンから API キーを入力して使用する |
| サーバー設定の変更 | データフォルダの `server.env`（LibreChat の `.env` に相当）と `librechat.yaml` で、API キーやエンドポイントを追加できる（設定画面から開く。再起動後に反映）。アドレス・データベース・暗号鍵など、内蔵サーバーの動作に必要な項目は Lamplight が管理する |
| ローカル LLM | 別途インストールした Ollama（`127.0.0.1:11434`）を使用する |
| PDF の受け渡し | Ollama の API はモデルを問わず PDF を直接受け取れないため、LibreChat の「テキストとしてアップロード」で文字として渡す。拡張機能なしでは文字情報を含む PDF のみ対応。OCR 拡張機能を追加すると、スキャンした PDF も glm-ocr で読み取る |

## 拡張機能仕様

拡張機能は、設定画面の「拡張機能」タブにある「ファイルから追加…」でインストールします。作成方法は [docs/EXTENSIONS.md](docs/EXTENSIONS.md) を参照してください。

| 項目 | 内容 |
| --- | --- |
| 配布形式 | `.lamplightext`（tar.gz）。`manifest.json`、プログラム、依存ライブラリ、`CHECKSUMS`（全ファイルの SHA-256）、`SIGNATURE`（任意。`CHECKSUMS` に対する Ed25519 署名）で構成する |
| 検証 | 全ファイルのハッシュが `CHECKSUMS` と一致し、余分なファイル・シンボリックリンクを含まないことを確認する。アプリケーションに組み込んだ公開鍵で署名を検証できたものは「公式」、それ以外は「開発元未確認」として、利用者の確認後にインストールする |
| 保存先 | `<データ保存先>/extensions/<id>/`（データは `extension-data/<id>/`、ログは `logs/ext-<id>.log`） |
| 実行形態 | Electron の Node.js で子プロセスとして起動する。設定は環境変数 `LAMPLIGHT_EXT_CONFIG` で渡す |
| 種別 | `ollama-proxy`: LibreChat と Ollama の間に入る OpenAI 互換のプロキシ（同時に有効化できるのは 1 つ） |
| 設定項目 | マニフェストの `settings` に定義した項目を設定画面に表示する（`text`、`ollama-model`） |
| OCR サービス | マニフェストに `ocrService` を定義すると、LibreChat の「テキストとしてアップロード」が拡張機能を OCR サービス（Mistral OCR 互換 API）として使用する。`librechat.yaml` の `# >>> lamplight: ocr` の範囲は Lamplight が管理する |
| 設定画面 | 設定（⌘, またはアカウントメニューの「設定」）の「拡張機能」タブ。上部メニュー・メニューバーの「拡張機能…」からも開く |

開発元の拡張機能のビルドと署名:

```sh
node scripts/extension-key.mjs      # 初回のみ。秘密鍵は ~/.config/lamplight/ に保存（リポジトリには含めない）
npm run build:ext                   # release/extensions/ocr-<version>-<platform>.lamplightext を作成
```

第三者の開発者は `scripts/pack-extension.mjs` でパッケージを作成できます（署名なし、または独自の鍵で署名）。

## LibreChat 組み込み構成

組み込む LibreChat のバージョンは、`package.json` の `lamplight.librechatVersion` で固定しています。ビルド時に `patches/librechat/` のパッチを適用します。

| パッチ | 内容 |
| --- | --- |
| `0001-writable-data-paths` | アップロードと画像の保存先を環境変数で変更可能にする（アプリケーション内部は書き込み不可のため） |
| `0002-disable-pwa-for-desktop` | PWA（Service Worker）を無効化する。アップデート後にキャッシュから旧画面が表示されることを防ぐ |
| `0003-recover-local-account` | キーチェーンの項目が失われた場合に、ローカル用アカウントを復旧するスクリプトを追加する |
| `0004-desktop-settings` | 設定画面に「デスクトップ」「拡張機能」タブを追加し、ログアウトを非表示にする（Lamplight 上で動作する場合のみ） |

## 開発環境

前提: Node.js 22 以上（macOS で `.icns` を生成する場合は `iconutil`）

```sh
npm install
npm run build:server               # 内蔵する LibreChat サーバーのビルド（初回、および LibreChat の更新時）
npm start                          # ビルドして起動
npm test                           # 単体テスト
npm run typecheck                  # 型チェック
npm run dist:mac                   # release/ に .dmg と .zip を作成（署名なし: CSC_IDENTITY_AUTO_DISCOVERY=false）
npm run build:server:linux -- x64  # Linux 用の内蔵サーバー（開発・検証用。Docker が必要）
npm run dist:linux                 # release/ に AppImage と .deb を作成（開発・検証用。配布は行わない）
```

リリース、コード署名、公証の手順は [docs/RELEASE.md](docs/RELEASE.md) を参照してください。

動作確認用スクリプト（一時プロファイルで起動し、画面を保存して終了）:

```sh
npm run build && npx electron scripts/smoke-embedded.cjs /tmp/out                          # 内蔵サーバーの初回起動
SMOKE_PROMPT="こんにちは" npx electron scripts/smoke-embedded.cjs /tmp/out /tmp/profile      # クイック入力からの送信
npm run build && npx electron scripts/smoke.cjs /tmp/out http://localhost:3080              # 外部サーバーモード
```

パッケージ化したアプリケーションを別のプロファイルで起動する場合は、`LAMPLIGHT_USER_DATA_DIR` を指定します。

```sh
LAMPLIGHT_USER_DATA_DIR=/tmp/lamplight-profile release/mac-arm64/Lamplight.app/Contents/MacOS/Lamplight
```

## ディレクトリ構成

```text
src/
├── main/
│   ├── main.ts            アプリケーションの起動、各機能の接続、IPC
│   ├── config.ts          設定の読み書きと検証
│   ├── urls.ts            LibreChat の URL の生成・判定
│   ├── brand.ts           名称・ロゴ・フッターの置き換え
│   ├── tray.ts            メニューバー / トレイ
│   ├── notifications.ts   応答完了通知
│   ├── serverStatus.ts    接続状態の確認（/health）
│   ├── updater.ts         自動アップデート
│   ├── server/            内蔵サーバー（MongoDB・LibreChat の起動と停止、秘密情報、自動サインイン）
│   ├── extensions/        拡張機能（インストール、検証、起動）
│   ├── platform/          OS ごとの差分（darwin / linux。Windows 対応時に追加）
│   └── windows/           メイン・クイック入力・設定の各ウィンドウ、lamplight:// スキーム
├── preload/               各画面に公開する API
└── renderer/              クイック入力・設定・起動・接続エラーの各画面
extensions/ocr/            OCR 拡張機能（PDF の画像化、OCR、表の変換、ocr-format、Excel 出力）
patches/librechat/         内蔵する LibreChat へのパッチ
resources/server/          ビルド済みの LibreChat サーバー（npm run build:server で生成。Git 管理外）
brand/                     ロゴ（SVG）
build/                     アプリケーションに組み込むアイコン類（brand/ から生成）
scripts/                   ビルド、リリース、拡張機能のパッケージ化、動作確認
tests/                     単体テスト
```

## ライセンス

Lamplight は [MIT ライセンス](LICENSE)で提供します。同梱するソフトウェア（LibreChat、Electron など）のライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載しています。MongoDB（SSPL）は同梱せず、初回起動時に利用者の同意を得て公式サイトから取得します。

## 関連資料

| 資料 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | システム構成 |
| [docs/EXTENSIONS.md](docs/EXTENSIONS.md) | 拡張機能開発ガイド |
| [docs/RELEASE.md](docs/RELEASE.md) | リリース手順（コード署名・公証を含む） |
