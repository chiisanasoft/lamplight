import { Menu, Tray, type MenuItemConstructorOptions } from "electron";
import type { Config, FavoriteModel } from "./config";
import type { Platform } from "./platform";
import type { ServerState } from "./serverStatus";

export interface TrayActions {
  newChat(favorite?: FavoriteModel): void;
  quickEntry(): void;
  showWindow(): void;
  settings(): void;
  extensions(): void;
  quit(): void;
}

const STATE_LABEL: Record<ServerState, string> = {
  unknown: "サーバー: 確認中…",
  online: "サーバー: ● 接続中",
  offline: "サーバー: ○ 接続できません",
};

export class AppTray {
  private tray: Tray;

  constructor(platform: Platform, private readonly actions: TrayActions) {
    this.tray = new Tray(platform.trayIcon());
    this.tray.setToolTip("Lamplight");
  }

  render(config: Config, state: ServerState, serverLabel: string) {
    const a = this.actions;
    const favorites: MenuItemConstructorOptions[] = config.favorites.length
      ? config.favorites.map((f) => ({ label: f.label, click: () => a.newChat(f) }))
      : [{ label: "（設定でモデルを登録）", enabled: false }];

    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "新しいチャット", click: () => a.newChat() },
      { label: "クイック入力", accelerator: config.quickEntryShortcut, click: a.quickEntry },
      { label: "モデルを選んで新しいチャット", submenu: favorites },
      { type: "separator" },
      { label: STATE_LABEL[state], enabled: false },
      { label: serverLabel, enabled: false },
      { type: "separator" },
      { label: "ウィンドウを表示", click: a.showWindow },
      { label: "設定…", accelerator: "CmdOrCtrl+,", click: a.settings },
      { label: "拡張機能…", click: a.extensions },
      { type: "separator" },
      { label: "Lamplight を終了", accelerator: "CmdOrCtrl+Q", click: a.quit },
    ]));
  }
}
