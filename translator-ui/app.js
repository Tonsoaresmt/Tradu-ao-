// Ponto de entrada: junta os módulos, liga os eventos e inicializa.
import { state, elements, clamp } from "./state.js";
import {
  renderCurrentPage,
  renderTranslationList,
  applyZoom,
  addBox,
  getCurrentPage,
  getCurrentPageRecord,
  getSelectedBox,
  orderedBoxes,
  selectBox,
  normalizeBoxes,
  updateSelectedBox,
  startDraw,
  handlePointerMove,
  handlePointerUp,
  setStatus,
  setToolStatus
} from "./editor.js";
import { loadLibrary, saveProject } from "./library.js";
import { runOcr, suggestPage, applySuggestions, acceptConfident, copyOriginals, autoOrganize, autoTranslatePage } from "./translator.js";
import { previewPage } from "./preview.js";
import { exportChapter, preprocessChapter } from "./export.js";
import { initAutosave } from "./autosave.js";

function toggleReading() {
  state.reading = !state.reading;
  document.body.classList.toggle("reading-mode", state.reading);
  elements.readingMode.textContent = state.reading ? "Editar" : "Leitura";
  requestAnimationFrame(() => applyZoom());
}

function navigateBox(dir) {
  const boxes = orderedBoxes();
  if (!boxes.length) return;
  const idx = boxes.findIndex((b) => b.id === state.selectedBoxId);
  const ni = idx < 0 ? (dir > 0 ? 0 : boxes.length - 1) : (idx + dir + boxes.length) % boxes.length;
  selectBox(boxes[ni].id);
  const input = elements.boxLayer.querySelector(`.translation-box[data-id="${boxes[ni].id}"] .box-input`);
  if (input) input.focus({ preventScroll: true });
}

function wireEvents() {
  elements.reloadLibrary.addEventListener("click", loadLibrary);
  elements.saveProject.addEventListener("click", () => saveProject().catch((error) => setStatus(error.message)));
  elements.exportChapter.addEventListener("click", () => exportChapter().catch((error) => setStatus(error.message)));
  elements.preprocessChapter.addEventListener("click", () => preprocessChapter().catch((error) => setToolStatus(error.message)));
  elements.previewPage.addEventListener("click", () => previewPage().catch((error) => setToolStatus(error.message)));
  elements.zoomIn.addEventListener("click", () => { state.zoom = Math.min(3, (state.zoom || 1) + 0.25); applyZoom(); });
  elements.zoomOut.addEventListener("click", () => { state.zoom = Math.max(0.5, (state.zoom || 1) - 0.25); applyZoom(); });
  elements.zoomFit.addEventListener("click", () => { state.zoom = 1; applyZoom(); });
  window.addEventListener("resize", () => applyZoom());
  elements.prevPage.addEventListener("click", () => {
    if (!state.pages.length) return;
    state.currentPageIndex = Math.max(0, state.currentPageIndex - 1);
    state.selectedBoxId = null;
    renderCurrentPage();
  });
  elements.nextPage.addEventListener("click", () => {
    if (!state.pages.length) return;
    state.currentPageIndex = Math.min(state.pages.length - 1, state.currentPageIndex + 1);
    state.selectedBoxId = null;
    renderCurrentPage();
  });
  elements.addLine.addEventListener("click", () => addBox());
  elements.runOcr.addEventListener("click", () => runOcr().catch((error) => setToolStatus(error.message)));
  elements.suggestPage.addEventListener("click", () => suggestPage().catch((error) => setToolStatus(error.message)));
  elements.applySuggestions.addEventListener("click", applySuggestions);
  elements.acceptConfident.addEventListener("click", () => acceptConfident(90));
  elements.autoOrganize.addEventListener("click", () => autoOrganize().catch((error) => setToolStatus(error.message)));
  elements.readingMode.addEventListener("click", toggleReading);
  elements.toggleAdvanced.addEventListener("click", () => {
    state.advanced = !state.advanced;
    document.body.classList.toggle("advanced", state.advanced);
    elements.toggleAdvanced.classList.toggle("on", state.advanced);
  });

  // Auto-tradução serializada e à prova de corrida.
  // - Processa UMA página por vez (autoBusy).
  // - Marca cada página como "processada" (mesmo com 0 balões) para não repetir
  //   nem entrar em loop em páginas vazias.
  // - Ao terminar, re-checa a página ATUAL: se o usuário navegou enquanto
  //   traduzia, a nova página atual entra na fila. Páginas puladas durante a
  //   navegação rápida são traduzidas quando você volta a elas.
  const autoProcessed = new Set();
  let autoBusy = false;
  async function maybeAutoTranslate() {
    if (autoBusy) return;
    const page = getCurrentPage();
    if (!page) return;
    const key = `${state.selectedManga}::${state.selectedChapter}::${page.name}`;
    const record = state.project.pages?.[page.name];
    if ((record && record.boxes && record.boxes.length) || autoProcessed.has(key)) return;
    autoBusy = true;
    autoProcessed.add(key);
    try {
      await autoTranslatePage(page);
    } catch (error) {
      autoProcessed.delete(key); // permite tentar de novo ao revisitar
      setToolStatus(error.message);
    } finally {
      autoBusy = false;
      maybeAutoTranslate(); // pega a página atual (pode ter mudado)
    }
  }
  window.addEventListener("page-shown", maybeAutoTranslate);
  elements.copyOriginals.addEventListener("click", () => copyOriginals().catch((error) => setToolStatus(error.message)));
  elements.removeBox.addEventListener("click", () => {
    const pageRecord = getCurrentPageRecord();
    if (!pageRecord || !state.selectedBoxId) return;

    pageRecord.boxes = pageRecord.boxes.filter((box) => box.id !== state.selectedBoxId);
    state.selectedBoxId = null;
    normalizeBoxes();
    renderCurrentPage();
  });

  elements.translatedText.addEventListener("input", () => {
    const box = getSelectedBox();
    if (!box) return;
    box.translatedText = elements.translatedText.value;
    const inline = elements.boxLayer.querySelector(".translation-box.selected .box-input");
    if (inline) inline.value = box.translatedText;
    renderTranslationList();
  });
  elements.useSuggestion.addEventListener("click", () => {
    const box = getSelectedBox();
    if (!box || !box.suggestedText) return;
    box.translatedText = box.suggestedText;
    elements.translatedText.value = box.translatedText;
    const inline = elements.boxLayer.querySelector(".translation-box.selected .box-input");
    if (inline) inline.value = box.translatedText;
    renderTranslationList();
  });

  // Copiar original / tradução (para comparar em outras ferramentas).
  const copyToClipboard = (text) => {
    if (!text) { setToolStatus("Nada para copiar."); return; }
    (navigator.clipboard?.writeText(text) || Promise.reject()).then(
      () => setToolStatus("Copiado para a área de transferência."),
      () => setToolStatus("Não consegui copiar (permissão do navegador).")
    );
  };
  elements.copyOriginalOne?.addEventListener("click", (event) => {
    event.preventDefault();
    const box = getSelectedBox();
    copyToClipboard(box?.originalText || "");
  });
  elements.copyTranslatedOne?.addEventListener("click", (event) => {
    event.preventDefault();
    const box = getSelectedBox();
    copyToClipboard(box?.translatedText || box?.suggestedText || "");
  });
  elements.boxType.addEventListener("change", () => updateSelectedBox({ type: elements.boxType.value }));
  elements.coverOriginal.addEventListener("change", () => updateSelectedBox({ coverOriginal: elements.coverOriginal.checked }));
  elements.fontSize.addEventListener("input", () => updateSelectedBox({ fontSize: Number(elements.fontSize.value) || 18 }));

  elements.boxX.addEventListener("input", () => {
    const box = getSelectedBox();
    if (!box) return;
    updateSelectedBox({ x: clamp(Number(elements.boxX.value) / 100, 0, 1 - box.width) });
  });
  elements.boxY.addEventListener("input", () => {
    const box = getSelectedBox();
    if (!box) return;
    updateSelectedBox({ y: clamp(Number(elements.boxY.value) / 100, 0, 1 - box.height) });
  });
  elements.boxWidth.addEventListener("input", () => {
    const box = getSelectedBox();
    if (!box) return;
    updateSelectedBox({ width: clamp(Number(elements.boxWidth.value) / 100, 0.05, 1 - box.x) });
  });
  elements.boxHeight.addEventListener("input", () => {
    const box = getSelectedBox();
    if (!box) return;
    updateSelectedBox({ height: clamp(Number(elements.boxHeight.value) / 100, 0.05, 1 - box.y) });
  });

  elements.boxLayer.addEventListener("pointerdown", startDraw);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);

  // Ajuste fino de posicao do balao selecionado: Alt + setas (Alt+Shift = passo maior).
  // Funciona mesmo digitando no balao (Alt nao interfere no cursor do texto).
  function nudgeSelectedBox(dx, dy) {
    const box = getSelectedBox();
    if (!box) return false;
    box.x = clamp(box.x + dx, 0, 1 - box.width);
    box.y = clamp(box.y + dy, 0, 1 - box.height);
    const node = elements.boxLayer.querySelector(`.translation-box[data-id="${box.id}"]`);
    if (node) { node.style.left = `${box.x * 100}%`; node.style.top = `${box.y * 100}%`; }
    if (elements.boxX) elements.boxX.value = (box.x * 100).toFixed(1);
    if (elements.boxY) elements.boxY.value = (box.y * 100).toFixed(1);
    return true;
  }

  // Atalhos: Tab/Shift+Tab navegam falas; Ctrl+S salva; Ctrl+Enter salva e vai p/ proxima pagina.
  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.key.startsWith("Arrow")) {
      const step = event.shiftKey ? 0.02 : 0.004;
      const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (delta && nudgeSelectedBox(delta[0] * step, delta[1] * step)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Tab") {
      event.preventDefault();
      navigateBox(event.shiftKey ? -1 : 1);
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveProject().catch((error) => setStatus(error.message));
      return;
    }
    if (mod && event.key === "Enter") {
      event.preventDefault();
      saveProject()
        .then(() => {
          if (state.currentPageIndex < state.pages.length - 1) {
            state.currentPageIndex += 1;
            state.selectedBoxId = null;
            renderCurrentPage();
          }
        })
        .catch((error) => setStatus(error.message));
    }
  });
}

wireEvents();
loadLibrary();
initAutosave();
