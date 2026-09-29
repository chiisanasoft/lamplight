const form = document.getElementById("form") as HTMLFormElement;
const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
const model = document.getElementById("model") as HTMLSelectElement;
const api = window.lamplight;

async function refresh() {
  const { favorites, defaultFavorite } = await api.state();
  model.replaceChildren(new Option("既定のモデル", "-1"));
  favorites.forEach((f, i) => model.append(new Option(f.label, String(i))));
  model.value = String(defaultFavorite);
  model.hidden = favorites.length === 0;
}

function send() {
  const text = prompt.value.trim();
  if (!text) return;
  api.submit(text, Number(model.value));
  prompt.value = "";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});

prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.hide();
});

api.onOpened(() => {
  void refresh();
  prompt.focus();
  prompt.select();
});

void refresh();

export {};
