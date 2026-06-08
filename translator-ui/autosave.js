// Salvamento automático: detecta mudança no projeto (snapshot) e grava sozinho
// a cada poucos segundos, e também ao fechar a aba (sendBeacon). Assim o
// trabalho não se perde se o Everton fechar sem clicar em "Salvar".
import { state, elements } from "./state.js";
import { api } from "./api.js";

const INTERVALO_MS = 10000;
let lastSnapshot = null;

function snapshot() {
  return JSON.stringify(state.project?.pages || {});
}

// Chamado ao abrir capítulo e ao salvar manualmente, pra não regravar à toa.
export function markChapterSaved() {
  lastSnapshot = snapshot();
}

function payload() {
  return JSON.stringify({
    manga: state.selectedManga,
    chapter: state.selectedChapter,
    pages: state.project.pages
  });
}

function setIndicator(text) {
  if (elements.autosaveIndicator) elements.autosaveIndicator.textContent = text;
}

async function autoSave() {
  if (!state.selectedManga || !state.selectedChapter) return;
  const snap = snapshot();
  if (snap === lastSnapshot) return; // nada mudou desde o último save

  try {
    await api("/api/project", { method: "POST", body: payload() });
    lastSnapshot = snap;
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    setIndicator(`salvo ${hora}`);
  } catch {
    setIndicator("falha ao salvar");
  }
}

export function initAutosave() {
  setInterval(autoSave, INTERVALO_MS);

  // Ao fechar/recarregar a aba: grava de forma síncrona via sendBeacon.
  window.addEventListener("beforeunload", () => {
    if (!state.selectedManga || !state.selectedChapter) return;
    if (snapshot() === lastSnapshot) return;
    try {
      const blob = new Blob([payload()], { type: "application/json" });
      navigator.sendBeacon("/api/project", blob);
    } catch {
      /* melhor esforço */
    }
  });
}
