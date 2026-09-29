# リリース手順

配布物は、本リポジトリの [Releases](https://github.com/chiisanasoft/lamplight/releases) で公開します。

| 配布物 | タグ | 用途 |
| --- | --- | --- |
| アプリケーション本体（macOS の `.dmg`、Linux の AppImage・`.deb`、自動アップデート用の `.zip`・`latest-mac.yml`・`latest-linux.yml`） | `v<バージョン>` | ダウンロード、自動アップデート（electron-updater） |
| 開発元の拡張機能（`.lamplightext`、署名付き） | `ext-<id>-v<バージョン>` | ダウンロード後、設定画面の「拡張機能」タブにある「ファイルから追加…」でインストール |

> リポジトリが非公開の間は、アプリケーションの自動アップデートは失敗します（HTTP 404）。

## アプリケーション本体のリリース

```sh
npm version <バージョン> --no-git-tag-version
npm run build:server                   # LibreChat の更新時のみ
npm run notices                        # 依存の変更時。THIRD_PARTY_NOTICES.md を更新してコミット
GH_TOKEN=$(gh auth token) npm run release:mac
npm run build:server:linux -- x64      # build:server の実行後（Docker が必要）
GH_TOKEN=$(gh auth token) npm run release:linux
```

`release:mac` は `.dmg` と `.zip`、`release:linux` は AppImage と `.deb` を作成し、同じ `v<バージョン>` の Release にアップロードします（更新情報 `latest-mac.yml`・`latest-linux.yml` を含む）。electron-builder の並列アップロードによる Release の重複作成エラーを避けるため、Release は事前に作成します（`scripts/release-app.mjs`）。`dist:mac`・`dist:linux` はアップロードを行いません（ローカルでの確認用）。

macOS の署名は全ファイルにタイムスタンプを付与するため、10〜40 分程度を要します。

### コード署名・公証

Gatekeeper の警告なしで配布するには、Apple Developer Program の **Developer ID Application** 証明書による署名と、公証（notarization）が必要です。「Apple Development」証明書のみの場合も署名は行われますが、他の Mac では警告が表示されます。

1. Apple Developer の Certificates で「Developer ID Application」証明書を作成し、ビルドに使用する Mac のキーチェーンに登録する。`security find-identity -v -p codesigning` に表示されれば、electron-builder が自動で使用する。
2. 公証用の認証情報をキーチェーンに保存する（App 用パスワードは appleid.apple.com で作成）。

   ```sh
   xcrun notarytool store-credentials lamplight-notary \
     --apple-id <Apple ID> --team-id <チーム ID>
   ```

3. リリース時にプロファイルを指定する。

   ```sh
   APPLE_KEYCHAIN_PROFILE=lamplight-notary GH_TOKEN=$(gh auth token) npm run release:mac
   ```

4. 結果を確認する。

   ```sh
   spctl -a -vvv -t install "release/mac-arm64/Lamplight.app"   # source=Notarized Developer ID
   ```

署名には Hardened Runtime を使用します。権限の定義は `build/entitlements.mac.plist` にあります。

- `allow-jit`、`allow-unsigned-executable-memory`: V8（アプリケーション本体、および `ELECTRON_RUN_AS_NODE` で実行する内蔵サーバー・拡張機能）のため
- `disable-library-validation`: 拡張機能は署名後にインストールされ、独自のネイティブモジュール（`@napi-rs/canvas` など）を読み込むため

自動アップデート（Squirrel.Mac）は、更新後のアプリケーションが同じ証明書で署名されていることを検証します。証明書が異なるバージョンへは自動更新されないため、配布するバージョンは常に同一の Developer ID 証明書で署名します。

## 拡張機能のリリース

```sh
npm run build:ext            # release/extensions/<id>-<バージョン>-<platform>.lamplightext（署名付き）
npm run release:ext          # ext-<id>-v<バージョン> の Release へアップロード
```

署名鍵（`~/.config/lamplight/extension-signing-key.pem`）はリポジトリに含めません。設定画面の拡張機能タブに一覧として表示する場合は、`src/main/extensions/catalog.ts` にダウンロード先を追加します（現在は空）。

## 作業後の整理

`release/` は作業用のフォルダです。配布後は削除します（古い Lamplight.app が Spotlight の検索結果に表示されるため）。
