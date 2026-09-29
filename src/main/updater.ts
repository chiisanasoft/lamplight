import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Updates from GitHub Releases (publish settings in electron-builder.yml). Checks on start when
 * enabled, downloads in the background and offers a restart; "アップデートを確認…" checks on demand.
 */
export class Updater {
  private checking = false;
  private downloaded = false;

  constructor() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("update-downloaded", (info) => {
      this.downloaded = true;
      void dialog
        .showMessageBox({
          type: "info",
          message: `Lamplight ${info.version} をダウンロードしました`,
          detail: "再起動すると更新されます。今は再起動しない場合、次に終了したときに更新されます。",
          buttons: ["再起動して更新", "あとで"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => response === 0 && autoUpdater.quitAndInstall());
    });
  }

  /** Development builds are not updated (there is nothing to replace). */
  get available(): boolean {
    return app.isPackaged && process.env.LAMPLIGHT_DISABLE_UPDATES !== "1";
  }

  /** Background check: failures (offline, no release yet) are only logged. */
  checkInBackground() {
    if (!this.available) return;
    void this.check().catch((err: unknown) =>
      console.warn("[lamplight] update check failed:", (err instanceof Error ? err.message : String(err)).split("\n")[0]),
    );
  }

  /** Menu command: reports the result either way. */
  async checkInteractively() {
    if (!this.available) {
      await dialog.showMessageBox({ type: "info", message: "この Lamplight は開発用のため、アップデートを確認できません" });
      return;
    }
    if (this.downloaded) {
      autoUpdater.quitAndInstall();
      return;
    }
    try {
      const result = await this.check();
      const latest = result?.updateInfo.version;
      if (!result?.isUpdateAvailable) {
        await dialog.showMessageBox({ type: "info", message: "Lamplight は最新です", detail: `バージョン ${app.getVersion()}` });
      } else {
        await dialog.showMessageBox({ type: "info", message: `Lamplight ${latest} があります`, detail: "バックグラウンドでダウンロードしています。完了したらお知らせします。" });
      }
    } catch (err) {
      await dialog.showMessageBox({
        type: "warning",
        message: "アップデートを確認できませんでした",
        detail: `インターネット接続を確認してください。配布元がまだ公開されていない可能性もあります。\n\n${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  }

  private async check() {
    if (this.checking) return null;
    this.checking = true;
    try {
      return await autoUpdater.checkForUpdates();
    } finally {
      this.checking = false;
    }
  }
}
