// Núcleo do editor: leitura de estado das páginas/caixas, renderização do
// visualizador, da lista de falas e do formulário, e manipulação das caixas.
import { state, elements, clamp, makeId } from "./state.js";

export function getCurrentPage() {
  return state.pages[state.currentPageIndex] || null;
}

export function getCurrentPageRecord() {
  const page = getCurrentPage();
  if (!page) return null;

  if (!state.project.pages[page.name]) {
    state.project.pages[page.name] = { boxes: [] };
  }

  state.project.pages[page.name].boxes ||= [];
  return state.project.pages[page.name];
}

export function orderedBoxes() {
  const pageRecord = getCurrentPageRecord();
  if (!pageRecord) return [];

  return [...pageRecord.boxes].sort((a, b) => (
    (a.order ?? 9999) - (b.order ?? 9999) ||
    (a.y ?? 0) - (b.y ?? 0) ||
    (a.x ?? 0) - (b.x ?? 0)
  ));
}

export function getSelectedBox() {
  return orderedBoxes().find((box) => box.id === state.selectedBoxId) || null;
}

export function setStatus(message) {
  elements.pageMeta.textContent = message;
}

export function setToolStatus(message) {
  elements.toolStatus.textContent = message;
}

export function createBox(values = {}) {
  const nextOrder = orderedBoxes().length + 1;
  return {
    id: makeId(),
    order: nextOrder,
    originalText: "",
    suggestedText: "",
    translatedText: "",
    coverOriginal: true,
    fontSize: 18,
    x: 0.08,
    y: 0.08,
    width: 0.34,
    height: 0.1,
    ...values
  };
}

export function normalizeBoxes() {
  orderedBoxes().forEach((box, index) => {
    box.order = index + 1;
  });
}

export function renderPageList() {
  elements.pageList.innerHTML = "";
  elements.pageCounter.textContent = state.pages.length
    ? `${state.currentPageIndex + 1} / ${state.pages.length}`
    : "0 / 0";

  for (const page of state.pages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-button";
    button.textContent = page.name;

    if (getCurrentPage()?.name === page.name) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      state.currentPageIndex = page.index;
      state.selectedBoxId = null;
      renderCurrentPage();
    });

    elements.pageList.appendChild(button);
  }
}

export function confClass(confidence) {
  if (typeof confidence !== "number") return "conf-none";
  if (confidence >= 90) return "conf-high";
  if (confidence >= 60) return "conf-mid";
  return "conf-low";
}

export function renderTranslationList() {
  const boxes = orderedBoxes();
  elements.translationList.innerHTML = "";
  elements.lineCounter.textContent = `${boxes.length}`;

  if (!boxes.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "Sem falas nesta pagina.";
    elements.translationList.appendChild(empty);
    return;
  }

  for (const box of boxes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "line-item";
    if (box.id === state.selectedBoxId) item.classList.add("selected");

    const conf = document.createElement("span");
    conf.className = `conf-dot ${confClass(box.confidence)}`;
    conf.title = typeof box.confidence === "number"
      ? `Confianca da deteccao/OCR: ${box.confidence}%`
      : "Sem confianca (caixa manual)";

    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(box.order).padStart(2, "0");

    const content = document.createElement("span");
    content.className = "line-content";

    const original = document.createElement("strong");
    original.textContent = box.originalText || "Texto original vazio";

    const translated = document.createElement("span");
    translated.textContent = box.translatedText || box.suggestedText || "Sem traducao";

    content.append(original, translated);
    item.append(conf, number, content);
    item.addEventListener("click", () => selectBox(box.id));
    elements.translationList.appendChild(item);
  }
}

export function syncBoxForm() {
  const box = getSelectedBox();
  const disabled = !box;

  for (const field of [
    elements.originalText,
    elements.suggestedText,
    elements.translatedText,
    elements.coverOriginal,
    elements.fontSize,
    elements.boxX,
    elements.boxY,
    elements.boxWidth,
    elements.boxHeight,
    elements.removeBox
  ]) {
    field.disabled = disabled;
  }

  if (!box) {
    elements.originalText.value = "";
    elements.suggestedText.value = "";
    elements.translatedText.value = "";
    elements.coverOriginal.checked = true;
    elements.fontSize.value = "18";
    elements.boxX.value = "";
    elements.boxY.value = "";
    elements.boxWidth.value = "";
    elements.boxHeight.value = "";
    return;
  }

  elements.originalText.value = box.originalText || "";
  elements.suggestedText.value = box.suggestedText || "";
  elements.translatedText.value = box.translatedText || "";
  elements.coverOriginal.checked = box.coverOriginal !== false;
  elements.fontSize.value = box.fontSize || 18;
  elements.boxX.value = (box.x * 100).toFixed(1);
  elements.boxY.value = (box.y * 100).toFixed(1);
  elements.boxWidth.value = (box.width * 100).toFixed(1);
  elements.boxHeight.value = (box.height * 100).toFixed(1);
}

export function renderBoxes() {
  elements.boxLayer.innerHTML = "";

  for (const box of orderedBoxes()) {
    const boxNode = document.createElement("button");
    boxNode.type = "button";
    boxNode.className = "translation-box";
    if (box.id === state.selectedBoxId) boxNode.classList.add("selected");

    boxNode.style.left = `${box.x * 100}%`;
    boxNode.style.top = `${box.y * 100}%`;
    boxNode.style.width = `${box.width * 100}%`;
    boxNode.style.height = `${box.height * 100}%`;
    boxNode.style.background = box.coverOriginal === false
      ? "rgba(248, 252, 252, 0.34)"
      : "rgba(255, 255, 255, 0.94)";
    boxNode.style.fontSize = `${box.fontSize || 18}px`;

    const label = document.createElement("div");
    label.className = "box-label";
    label.textContent = `Fala ${String(box.order).padStart(2, "0")}`;

    const text = document.createElement("div");
    text.className = "box-text";
    text.textContent = box.translatedText || box.suggestedText || box.originalText || "...";

    boxNode.append(label, text);
    boxNode.addEventListener("click", (event) => {
      event.stopPropagation();
      selectBox(box.id);
    });

    boxNode.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectBox(box.id);

      state.drag = {
        id: box.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: box.x,
        startY: box.y
      };

      boxNode.setPointerCapture(event.pointerId);
    });

    elements.boxLayer.appendChild(boxNode);
  }
}

export function renderCurrentPage() {
  const page = getCurrentPage();
  state.previewing = false;
  if (elements.previewPage) elements.previewPage.textContent = "Previa";
  renderPageList();

  if (!page) {
    elements.viewerStage.classList.add("empty");
    elements.viewerStage.classList.remove("ready");
    elements.pageImage.removeAttribute("src");
    elements.boxLayer.innerHTML = "";
    renderTranslationList();
    syncBoxForm();
    setStatus("Selecione um capitulo na lateral.");
    setToolStatus("Abra uma pagina para comecar.");
    return;
  }

  elements.viewerStage.classList.remove("empty");
  elements.viewerStage.classList.add("ready");
  elements.pageImage.src = page.url;
  elements.pageImage.onload = () => renderBoxes();

  normalizeBoxes();
  renderTranslationList();
  syncBoxForm();
  setStatus(`Pagina ${page.index + 1} de ${state.pages.length}`);
  setToolStatus(toolSummary());
}

export function toolSummary() {
  const hasLocalOcr = state.tools?.ocr?.available || state.tools?.ocr?.providers?.windows;
  const ocr = hasLocalOcr
    ? "OCR local pronto"
    : state.tools?.ocr?.providers?.openaiConfigured
      ? "OCR por IA externa habilitado"
      : "OCR indisponivel";
  const provider = state.tools?.translation?.provider || "local-basic";
  return `${ocr}. Sugestao: ${provider}.`;
}

export function selectBox(id) {
  state.selectedBoxId = id;
  renderBoxes();
  renderTranslationList();
  syncBoxForm();
}

export function addBox(values = {}) {
  const pageRecord = getCurrentPageRecord();
  if (!pageRecord) return null;

  const box = createBox(values);
  pageRecord.boxes.push(box);
  normalizeBoxes();
  selectBox(box.id);
  return box;
}

export function startDraw(event) {
  if (!getCurrentPage() || event.target !== elements.boxLayer) return;

  const imageRect = elements.pageImage.getBoundingClientRect();
  if (!imageRect.width || !imageRect.height) return;

  state.draw = {
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: clamp((event.clientX - imageRect.left) / imageRect.width, 0, 0.95),
    startY: clamp((event.clientY - imageRect.top) / imageRect.height, 0, 0.95)
  };
  elements.boxLayer.setPointerCapture(event.pointerId);
  setToolStatus("Arraste ate cobrir o texto que sera substituido.");
}

export function updateSelectedBox(patch) {
  const box = getSelectedBox();
  if (!box) return;

  Object.assign(box, patch);
  renderBoxes();
  renderTranslationList();
}

export function handlePointerMove(event) {
  if (state.draw) {
    const imageRect = elements.pageImage.getBoundingClientRect();
    const currentX = clamp((event.clientX - imageRect.left) / imageRect.width, 0, 1);
    const currentY = clamp((event.clientY - imageRect.top) / imageRect.height, 0, 1);
    const width = Math.abs(currentX - state.draw.startX);
    const height = Math.abs(currentY - state.draw.startY);
    setToolStatus(`Nova area: ${Math.round(width * 100)}% x ${Math.round(height * 100)}%.`);
    return;
  }

  if (!state.drag) return;

  const box = getSelectedBox();
  const imageRect = elements.pageImage.getBoundingClientRect();
  if (!box || !imageRect.width || !imageRect.height) return;

  const deltaX = (event.clientX - state.drag.startClientX) / imageRect.width;
  const deltaY = (event.clientY - state.drag.startClientY) / imageRect.height;

  box.x = clamp(state.drag.startX + deltaX, 0, 1 - box.width);
  box.y = clamp(state.drag.startY + deltaY, 0, 1 - box.height);
  syncBoxForm();
  renderBoxes();
  renderTranslationList();
}

export function handlePointerUp(event) {
  if (state.draw) {
    const imageRect = elements.pageImage.getBoundingClientRect();
    const endX = imageRect.width
      ? clamp((event.clientX - imageRect.left) / imageRect.width, 0, 1)
      : state.draw.startX;
    const endY = imageRect.height
      ? clamp((event.clientY - imageRect.top) / imageRect.height, 0, 1)
      : state.draw.startY;
    const left = Math.min(state.draw.startX, endX);
    const top = Math.min(state.draw.startY, endY);
    const width = Math.max(0.12, Math.abs(endX - state.draw.startX) || 0.34);
    const height = Math.max(0.06, Math.abs(endY - state.draw.startY) || 0.1);

    addBox({
      x: clamp(left, 0, 1 - width),
      y: clamp(top, 0, 1 - height),
      width: clamp(width, 0.05, 1 - left),
      height: clamp(height, 0.04, 1 - top)
    });
    state.draw = null;
    setToolStatus("Area criada. Escreva a traducao final para ver a substituicao.");
    return;
  }

  state.drag = null;
}
