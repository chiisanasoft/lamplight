const api = window.lamplight;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const serverUrl = $<HTMLInputElement>("serverUrl");
const shortcut = $<HTMLInputElement>("shortcut");
const favoritesEl = $<HTMLDivElement>("favorites");
const rowTemplate = $<HTMLTemplateElement>("favoriteRow");
const ollama = $<HTMLSelectElement>("ollama");
const toggles = ["notifyOnComplete", "keepRunningInTray", "launchAtLogin", "checkForUpdates"] as const;

// Shown as a tab of LibreChat's settings dialog: settings.html?embed=1&view=desktop|extensions&theme=dark|light
const params = new URLSearchParams(location.search);
const embedView = params.get("embed") === "1" ? (params.get("view") === "extensions" ? "extensions" : "desktop") : null;
if (embedView) {
  document.documentElement.classList.add("embed");
  document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  if (embedView === "extensions") {
    document.querySelectorAll<HTMLElement>("form > section:not(#extSection), form > footer").forEach((e) => (e.hidden = true));
  }
}

function status(el: HTMLElement, text: string, kind: "ok" | "err" | "" = "") {
  el.textContent = text;
  el.className = `note ${kind}`;
}

function addRow(f: Partial<FavoriteModel> = {}) {
  const row = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
  row.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
    input.value = f[input.dataset.k as keyof FavoriteModel] ?? "";
  });
  row.querySelector(".remove")!.addEventListener("click", () => row.remove());
  favoritesEl.append(row);
  return row;
}

function readFavorites(): FavoriteModel[] {
  return [...favoritesEl.children].map((row) => {
    const get = (k: string) => (row.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!.value || "").trim();
    return { label: get("label"), endpoint: get("endpoint"), model: get("model") };
  }).filter((f) => f.endpoint && f.model);
}

const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="serverMode"]')];
const selectedMode = () => (modeInputs.find((i) => i.checked)?.value ?? "embedded") as LamplightConfig["serverMode"];
let activeMode: LamplightConfig["serverMode"] = "embedded";

function renderMode() {
  $("externalFields").hidden = selectedMode() !== "external";
  // Extensions run next to the embedded server; an external server brings its own features
  $("extSection").hidden = embedView === "desktop" || (embedView !== "extensions" && selectedMode() !== "embedded");
  $("extExternal").hidden = activeMode === "embedded";
  $("embeddedFields").hidden = $("embeddedNote").hidden = selectedMode() !== "embedded";
  $("restartNote").hidden = selectedMode() === activeMode;
}
modeInputs.forEach((i) => i.addEventListener("change", renderMode));

async function load() {
  const c = await api.get();
  activeMode = c.activeServerMode ?? c.serverMode;
  modeInputs.forEach((i) => (i.checked = i.value === c.serverMode));
  renderMode();
  serverUrl.value = c.serverUrl;
  shortcut.value = c.quickEntryShortcut;
  favoritesEl.replaceChildren();
  c.favorites.forEach((f) => addRow(f));
  for (const k of toggles) $<HTMLInputElement>(k).checked = c[k];

  const models = await api.ollamaModels();
  ollama.hidden = models.length === 0;
  models.forEach((m) => ollama.append(new Option(m, m)));

  ollamaModelList = models;
  await renderExtensions();
}

$("test").addEventListener("click", async () => {
  status($("testResult"), "確認中…");
  const ok = await api.testServer(serverUrl.value);
  status($("testResult"), ok ? "接続できました。" : "接続できません。URL とサーバーの起動状態を確認してください。", ok ? "ok" : "err");
});

$("relaunch").addEventListener("click", () => api.relaunch());
document.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) =>
  b.addEventListener("click", () => api.openServerFile(b.dataset.open as "serverEnv" | "librechatYaml" | "dataDir")),
);

$("addFavorite").addEventListener("click", () => addRow().querySelector("input")?.focus());

ollama.addEventListener("change", () => {
  if (!ollama.value) return;
  addRow({ label: ollama.value.replace(/:latest$/, ""), endpoint: "Ollama", model: ollama.value });
  ollama.value = "";
});

$<HTMLFormElement>("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await api.save({
    serverMode: selectedMode(),
    serverUrl: serverUrl.value,
    quickEntryShortcut: shortcut.value,
    favorites: readFavorites(),
    ...Object.fromEntries(toggles.map((k) => [k, $<HTMLInputElement>(k).checked])),
  });
  if (!res.ok) return status($("saveResult"), res.error ?? "保存できませんでした。", "err");
  if (res.shortcutError) return status($("saveResult"), `保存しました。ただし ${res.shortcutError}`, "err");
  status($("saveResult"), res.restartRequired ? "保存しました。再起動するとサーバーが切り替わります。" : "保存しました。", "ok");
  renderMode();
});

// ------------------------------------------------------------ extensions

let ollamaModelList: string[] = [];

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag), props) as unknown as T;
  e.append(...children);
  return e;
}

function extResult(res: { ok: boolean; error?: string; restartRequired?: boolean; name?: string; canceled?: boolean }, done: string) {
  if (res.canceled) return;
  if (!res.ok) return status($("extStatus"), res.error ?? "失敗しました。", "err");
  status($("extStatus"), done, "ok");
  if (res.restartRequired) $("extRestart").hidden = false;
  void renderExtensions();
}

async function renderExtensions() {
  const list = await api.extList();
  const box = $("extList");
  box.replaceChildren();
  const installedIds = new Set(list.installed.map((e) => e.manifest.id));

  for (const ext of list.installed) {
    const m = ext.manifest;
    const card = el("div", { className: "ext" });
    const toggle = el<HTMLInputElement>("input", { type: "checkbox", checked: ext.enabled, id: `ext-${m.id}` });
    toggle.addEventListener("change", async () => extResult(await api.extSetEnabled(m.id, toggle.checked), toggle.checked ? "有効にしました。" : "無効にしました。"));
    card.append(
      el("div", { className: "ext-head" },
        el("label", { className: "check", htmlFor: `ext-${m.id}` }, toggle, el("strong", {}, m.name)),
        el("span", { className: "ext-meta" }, `v${m.version}${ext.running ? " ・ 動作中" : ""}`)),
      el("p", { className: "note" },
        el("span", { className: ext.official ? "badge" : "badge warn" }, ext.official ? "公式" : "開発元未確認"),
        ` ${m.author ? `作成者: ${m.author}` : ""}`),
      el("p", { className: "note" }, m.description),
    );
    const missing = (m.requires?.ollamaModels ?? []).filter((r) => !ollamaModelList.some((x) => x.startsWith(r)));
    if (missing.length) card.append(el("p", { className: "note err" }, `必要なモデルがありません: ${missing.map((x) => `ollama pull ${x}`).join("、")}`));

    const inputs: [string, HTMLInputElement | HTMLSelectElement][] = [];
    for (const setting of m.settings ?? []) {
      let input: HTMLInputElement | HTMLSelectElement;
      if (setting.type === "ollama-model") {
        input = el<HTMLSelectElement>("select", {}, el("option", { value: "" }, "使わない"));
        ollamaModelList.filter((x) => !/ocr|embed|rerank/i.test(x)).forEach((x) => input.append(new Option(x, x)));
        const current = ext.settings[setting.key] ?? "";
        if (current && !ollamaModelList.includes(current)) input.append(new Option(`${current}（見つかりません）`, current));
        input.value = current;
      } else {
        input = el<HTMLInputElement>("input", { type: "text", value: ext.settings[setting.key] ?? "", placeholder: setting.default });
      }
      input.id = `ext-${m.id}-${setting.key}`;
      inputs.push([setting.key, input]);
      card.append(el("label", { htmlFor: input.id }, setting.label), input);
      if (setting.description) card.append(el("p", { className: "note" }, setting.description));
    }
    const actions = el("div", { className: "inline" });
    if (inputs.length) {
      const save = el("button", { type: "button" }, "設定を保存");
      save.addEventListener("click", async () =>
        extResult(await api.extSaveSettings(m.id, Object.fromEntries(inputs.map(([k, i]) => [k, i.value.trim()]))), `「${m.name}」の設定を保存しました。`));
      actions.append(save);
    }
    const remove = el("button", { type: "button", className: "danger" }, "削除");
    remove.addEventListener("click", async () => extResult(await api.extUninstall(m.id), `「${m.name}」を削除しました。`));
    actions.append(remove);
    card.append(actions);
    if (m.license || m.homepage) {
      card.append(el("p", { className: "note" }, [m.license && `ライセンス: ${m.license}`, m.homepage].filter(Boolean).join(" ・ ")));
    }
    box.append(card);
  }

  for (const entry of list.catalog.filter((e) => !installedIds.has(e.id))) {
    const add = el<HTMLButtonElement>("button", { type: "button", disabled: !entry.available }, entry.available ? "追加" : "配布準備中");
    add.addEventListener("click", async () => {
      add.disabled = true;
      status($("extStatus"), `「${entry.name}」をダウンロードしています…`);
      extResult(await api.extInstallCatalog(entry.id), `「${entry.name}」を追加しました。`);
    });
    box.append(el("div", { className: "ext" },
      el("div", { className: "ext-head" }, el("strong", {}, entry.name), add),
      el("p", { className: "note" }, entry.description)));
  }
}

$("extFile").addEventListener("click", async () => {
  const res = await api.extInstallFile();
  extResult(res, `「${res.name ?? "拡張機能"}」を追加しました。`);
});
$("extRestartBtn").addEventListener("click", () => {
  api.extRestartServer();
  $("extRestart").hidden = true;
  status($("extStatus"), "サーバーを再起動しています。メインウィンドウをご確認ください。");
  setTimeout(() => void renderExtensions(), 15000);
});

api.onFocusSection((id) => {
  const section = document.getElementById(id);
  if (!section || section.hidden) return;
  section.scrollIntoView({ behavior: "smooth", block: "start" });
});

void load();

export {};
