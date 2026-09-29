type Step =
  | { step: "consent" }
  | { step: "download"; progress: number }
  | { step: "database" | "extensions" | "server" | "account" | "signin" }
  | { step: "ready"; url: string; ollama: boolean }
  | { step: "error"; message: string };

const api = window.lamplight;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const order = ["download", "database", "extensions", "account", "server", "signin"];

function render(s: Step | null) {
  if (!s) return;
  $("consent").hidden = s.step !== "consent";
  $("error").hidden = s.step !== "error";
  $("steps").hidden = s.step === "consent";

  if (s.step === "download") {
    ($("progress") as HTMLProgressElement).value = s.progress;
    (document.querySelector('[data-step="download"]') as HTMLElement).hidden = false;
  }
  if (s.step === "account" || s.step === "extensions") (document.querySelector(`[data-step="${s.step}"]`) as HTMLElement).hidden = false;
  if (s.step === "error") {
    $("title").textContent = "起動できませんでした";
    $("errorText").textContent = s.message;
  }
  if (s.step === "ready") {
    $("title").textContent = "準備ができました";
    $("ollama").hidden = s.ollama;
  }

  const current = order.indexOf(s.step);
  document.querySelectorAll<HTMLElement>("#steps li").forEach((li) => {
    const i = order.indexOf(li.dataset.step ?? "");
    li.classList.toggle("done", s.step === "ready" || (current >= 0 && i < current));
    li.classList.toggle("active", i === current);
  });
}

$("agree").addEventListener("click", () => {
  $("consent").hidden = true;
  $("steps").hidden = false;
  api.consent();
});
$("external").addEventListener("click", () => api.openSettings());
$("retry").addEventListener("click", () => {
  $("title").textContent = "Lamplight を起動しています";
  $("error").hidden = true;
  api.retryStartup();
});
$("settings").addEventListener("click", () => api.openSettings());

api.onStartupStep((s) => render(s as Step));
void api.startupState().then((s) => render(s as Step | null));

export {};
