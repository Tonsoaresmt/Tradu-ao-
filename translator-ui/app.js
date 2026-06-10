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
import { loadLibrary, saveProject, refreshSystemStatus } from "./library.js";
import { runOcr, suggestPage, applySuggestions, acceptConfident, copyOriginals, autoOrganize, autoTranslatePage, loadCleanBackground, reviewPage, retranslatePage } from "./translator.js";
import { previewPage } from "./preview.js";
import { exportChapter, preprocessChapter } from "./export.js";
import { initAutosave } from "./autosave.js";

function toggleReading() {
  state.reading = !state.reading;
  document.body.classList.toggle("reading-mode", state.reading);
  elements.readingMode.textContent = state.reading ? "Editar" : "Revisão";
  requestAnimationFrame(() => applyZoom());
}

// ===== Abas da página grande: Original | Dublado (Comparar alterna as duas) =====
function setView(view) {
  state.view = view;
  document.body.classList.toggle("view-original", view === "original");
  elements.viewOriginal?.classList.toggle("on", view === "original");
  elements.viewDublado?.classList.toggle("on", view !== "original");
  requestAnimationFrame(() => applyZoom());
}

// ===== Zoom: a imagem visível e o palco visível (aba Original ou Dublado) =====
function visibleImg() {
  return document.body.classList.contains("view-original") ? elements.pageImageOriginal : elements.pageImage;
}
function visibleStage() {
  return elements.viewerStage?.clientHeight ? elements.viewerStage : elements.origStage;
}
function zoomFitWidth() {
  const img = visibleImg();
  const stage = visibleStage();
  if (!img?.naturalWidth || !stage?.clientHeight) return;
  const h = Math.max(120, stage.clientHeight - 16);
  const targetW = Math.max(120, stage.clientWidth - 24);
  state.zoom = clamp((targetW * img.naturalHeight) / (img.naturalWidth * h), 0.2, 6);
  applyZoom();
}
function zoom100() {
  const img = visibleImg();
  const stage = visibleStage();
  if (!img?.naturalHeight || !stage?.clientHeight) return;
  const h = Math.max(120, stage.clientHeight - 16);
  state.zoom = clamp(img.naturalHeight / h, 0.2, 6);
  applyZoom();
}

function navigateBox(dir) {
  const boxes = orderedBoxes();
  if (!boxes.length) return;
  const idx = boxes.findIndex((b) => b.id === state.selectedBoxId);
  const ni = idx < 0 ? (dir > 0 ? 0 : boxes.length - 1) : (idx + dir + boxes.length) % boxes.length;
  // Seleciona SEM focar o texto (bancada: Tab navega, Enter edita, Esc sai).
  selectBox(boxes[ni].id);
}

// Q/E: fonte da fala selecionada −/+ (trava no tamanho escolhido, como o campo Fonte).
function adjustSelectedFont(delta) {
  const box = getSelectedBox();
  if (!box) return false;
  let base = box.fontLocked ? Number(box.fontSize) || 0 : 0;
  if (!base) {
    // parte do tamanho ATUAL auto-ajustado (px do editor -> px da página)
    const inline = elements.boxLayer.querySelector(".translation-box.selected .box-input");
    const scale = (elements.pageImage.clientHeight || 1) / (elements.pageImage.naturalHeight || 1);
    const px = inline ? parseFloat(getComputedStyle(inline).fontSize) : 18;
    base = Math.round(px / (scale || 1)) || 18;
  }
  const size = clamp(base + delta, 8, 160);
  updateSelectedBox({ fontSize: size, fontLocked: true });
  if (elements.fontSize) elements.fontSize.value = size;
  return true;
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
  elements.zoomFitW?.addEventListener("click", zoomFitWidth);
  elements.zoom100?.addEventListener("click", zoom100);
  elements.viewOriginal?.addEventListener("click", () => setView("original"));
  elements.viewDublado?.addEventListener("click", () => setView("dublado"));
  elements.viewComparar?.addEventListener("click", () => setView(state.view === "original" ? "dublado" : "original"));
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
  elements.reviewPage?.addEventListener("click", () => reviewPage().catch((error) => setToolStatus(error.message)));
  elements.retranslatePage?.addEventListener("click", () => retranslatePage().catch((error) => setToolStatus(error.message)));
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
  let statusSynced = false;
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
      // O detector ja subiu aqui -> atualiza a barra de status (EasyOCR·GPU etc.).
      if (!statusSynced) statusSynced = await refreshSystemStatus();
      loadCleanBackground();   // troca o fundo da aba Traducao pelo inpaint (sem ingles, rosto preservado)
      maybeAutoTranslate(); // pega a página atual (pode ter mudado)
    }
  }
  window.addEventListener("page-shown", maybeAutoTranslate);
  // Paginas que JA tem baloes (salvas): carrega o fundo limpo ao exibir.
  window.addEventListener("page-shown", () => loadCleanBackground());
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
  elements.fontSize.addEventListener("input", () => updateSelectedBox({ fontSize: Number(elements.fontSize.value) || 18, fontLocked: true }));
  elements.fontWeight.addEventListener("input", () => updateSelectedBox({ fontWeight: Number(elements.fontWeight.value) || 0 }));
  // Botao "Centralizar": re-renderiza os baloes (re-aplica centralizacao/encaixe).
  elements.centerBoxes?.addEventListener("click", () => { renderCurrentPage(); setToolStatus("Balões re-centralizados nesta página."); });

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

  // ===== Atalhos da BANCADA =====
  // Regra: atalhos de LETRA (Q/E/R/T, WASD, Z/X/C/V, Espaço) só valem FORA da
  // digitação. Tab navega sempre; Enter entra no texto da fala; Esc sai dela.
  const isTyping = () => /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "");
  const onButton = () => /^(button|summary|a)$/i.test(document.activeElement?.tagName || "");
  function editSelectedBox() {
    const input = elements.boxLayer.querySelector(".translation-box.selected .box-input");
    if (input) input.focus({ preventScroll: true });
  }
  function gotoPage(delta) {
    if (!state.pages.length) return;
    const next = clamp(state.currentPageIndex + delta, 0, state.pages.length - 1);
    if (next === state.currentPageIndex) return;
    state.currentPageIndex = next;
    state.selectedBoxId = null;
    renderCurrentPage();
  }

  window.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;

    // — sempre ativos (até digitando) —
    if (event.key === "Tab") { event.preventDefault(); navigateBox(event.shiftKey ? -1 : 1); return; }
    if (event.key === "PageDown") { event.preventDefault(); gotoPage(1); return; }
    if (event.key === "PageUp") { event.preventDefault(); gotoPage(-1); return; }
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveProject().catch((error) => setStatus(error.message));
      return;
    }
    if (mod && event.key === "Enter") {
      event.preventDefault();
      saveProject().then(() => gotoPage(1)).catch((error) => setStatus(error.message));
      return;
    }
    if (event.key === "Escape") {
      if (isTyping()) { document.activeElement.blur(); event.preventDefault(); }
      return;
    }
    // Alt+setas: ajuste fino de posição (funciona até digitando)
    if (event.altKey && event.key.startsWith("Arrow")) {
      const step = event.shiftKey ? 0.02 : 0.004;
      const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (delta && nudgeSelectedBox(delta[0] * step, delta[1] * step)) { event.preventDefault(); return; }
    }

    if (isTyping()) return;            // daqui pra baixo: só FORA da digitação
    if (mod || event.altKey) return;   // não rouba Ctrl/Alt+letra do navegador

    const k = event.key.toLowerCase();

    if (event.key === "Enter") { if (onButton()) return; event.preventDefault(); editSelectedBox(); return; }
    if (event.key === " ") { if (onButton()) return; event.preventDefault(); toggleReading(); return; }

    // Lettering: Q/E fonte − / +, R centralizar, T volta pro automático
    if (k === "q" || k === "e") { if (adjustSelectedFont(k === "e" ? 1 : -1)) event.preventDefault(); return; }
    if (k === "r") { event.preventDefault(); renderCurrentPage(); setToolStatus("Balões re-centralizados nesta página."); return; }
    if (k === "t") { event.preventDefault(); updateSelectedBox({ fontLocked: false }); setToolStatus("Fonte da fala voltou para o ajuste automático."); return; }

    // Movimento: WASD (Shift = rápido). Fino = Alt+setas (Ctrl+W fecharia a aba do navegador).
    const wasd = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] }[k];
    if (wasd) {
      const step = event.shiftKey ? 0.02 : 0.006;
      if (nudgeSelectedBox(wasd[0] * step, wasd[1] * step)) event.preventDefault();
      return;
    }

    // Visualização: Z altura, X 100%, C/V zoom +/−
    if (k === "z") { event.preventDefault(); state.zoom = 1; applyZoom(); return; }
    if (k === "x") { event.preventDefault(); zoom100(); return; }
    if (k === "c") { event.preventDefault(); state.zoom = Math.min(6, (state.zoom || 1) + 0.25); applyZoom(); return; }
    if (k === "v") { event.preventDefault(); state.zoom = Math.max(0.2, (state.zoom || 1) - 0.25); applyZoom(); return; }
  });
}

wireEvents();
loadLibrary();
initAutosave();

// O detector sobe sob demanda e a 1a vez demora (carrega YOLO + EasyOCR). A barra
// de status inicial pode sair "Detector vermelho / CPU"; este poll a atualiza
// sozinho assim que o detector ficar pronto (depois para).
(function pollStatusUntilReady() {
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    const ready = await refreshSystemStatus();
    if (ready || tries >= 30) clearInterval(timer);
  }, 5000);
})();
