const params = new URLSearchParams(location.search);
(document.getElementById("url") as HTMLElement).textContent = params.get("url") ?? "";
const reason = params.get("reason");
if (reason) (document.getElementById("reason") as HTMLElement).textContent = `詳細: ${reason}`;
document.getElementById("retry")?.addEventListener("click", () => window.lamplight.retry());
document.getElementById("settings")?.addEventListener("click", () => window.lamplight.openSettings());

export {};
