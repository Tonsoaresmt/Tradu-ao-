// Ponto de entrada: junta os módulos, liga os eventos e inicializa.
import { state, elements, clamp } from "./state.js";
import {
  renderCurrentPage,
  addBox,
  getCurrentPageRecord,
  getSelectedBox,
  normalizeBoxes,
  updateSelectedBox,
  startDraw,
  handlePointerMove,
  handlePointerUp,
  setStatus,
  setToolStatus
} from "./editor.js";
import { loadLibrary, saveProject } from "./library.js";
import { runOcr, suggestPage, applySuggestions, acceptConfident, copyOriginals } from "./translator.js";
import { previewPage } from "./preview.js";
import { exportChapter, preprocessChapter } from "./export.js";

function wireEvents() {
  elements.reloadLibrary.addEventListener("click", loadLibrary);
  elements.saveProject.addEventListener("click", () => saveProject().catch((error) => setStatus(error.message)));
  elements.exportChapter.addEventListener("click", () => exportChapter().catch((error) => setStatus(error.message)));
  elements.preprocessChapter.addEventListener("click", () => preprocessChapter().catch((error) => setToolStatus(error.message)));
  elements.previewPage.addEventListener("click", () => previewPage().catch((error) => setToolStatus(error.message)));
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
  elements.copyOriginals.addEventListener("click", () => copyOriginals().catch((error) => setToolStatus(error.message)));
  elements.removeBox.addEventListener("click", () => {
    const pageRecord = getCurrentPageRecord();
    if (!pageRecord || !state.selectedBoxId) return;

    pageRecord.boxes = pageRecord.boxes.filter((box) => box.id !== state.selectedBoxId);
    state.selectedBoxId = null;
    normalizeBoxes();
    renderCurrentPage();
  });

  elements.originalText.addEventListener("input", () => updateSelectedBox({ originalText: elements.originalText.value }));
  elements.suggestedText.addEventListener("input", () => updateSelectedBox({ suggestedText: elements.suggestedText.value }));
  elements.translatedText.addEventListener("input", () => updateSelectedBox({ translatedText: elements.translatedText.value }));
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
}

wireEvents();
loadLibrary();
