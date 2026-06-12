// Núcleo do editor: leitura de estado das páginas/caixas, renderização do
// visualizador, da lista de falas e do formulário, e manipulação das caixas.
import { state, elements, clamp, makeId } from "./state.js";
import { looksTruncated } from "./text-checks.js";

// Auto-ajuste da fonte no editor: encolhe o texto ate caber no balao (igual ao
// resultado final), pra dar pra ler na hora em vez de cortar.
const _measureCanvas = document.createElement("canvas");
const _measureCtx = _measureCanvas.getContext("2d");

// Auto-ajuste: maior fonte que faz o texto caber DENTRO do balão. Desconta o
// padding+borda reais (~7px lado a lado) e usa a mesma entrelinha do CSS (1.15),
// senão a conta superestima o espaço em balões pequenos e o texto corta.
const _BOX_PAD = 7;   // padding(3) + borda(2) por lado, com folga
const _LINE_H = 1.15;

export function fitBoxFont(text, wPx, hPx) {
  const t = String(text || "").trim();
  if (wPx < 8 || hPx < 8) return 11;
  const availW = Math.max(8, wPx - _BOX_PAD * 2);
  const availH = Math.max(8, hPx - _BOX_PAD * 2);
  if (!t) return Math.max(9, Math.min(Math.floor(availH * 0.45), 64));

  // Teto alto (limitado pela ALTURA do balão, não por um px fixo) -> a fonte
  // acompanha proporcionalmente o zoom, sem "fugir do padrão" em escala maior.
  let size = Math.max(8, Math.min(Math.floor(availH), 240));
  for (; size >= 8; size--) {
    _measureCtx.font = `700 ${size}px sans-serif`;
    const words = t.split(/\s+/);
    let lines = 1;
    let current = "";
    let ok = true;
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (_measureCtx.measureText(test).width <= availW) {
        current = test;
      } else {
        if (_measureCtx.measureText(word).width > availW) { ok = false; break; }
        lines += 1;
        current = word;
      }
    }
    if (!ok) continue;
    if (lines * size * _LINE_H <= availH) return size;
  }
  return 8;
}

// Ajusta a altura da caixa de texto ao conteúdo pra o flex CENTRALIZAR vertical
// (textarea sozinho alinha no topo). Mantém centralizado em qualquer zoom.
function autoSizeInput(input, node) {
  input.style.height = "auto";
  const h = Math.min(node.clientHeight - 2, input.scrollHeight);
  input.style.height = `${Math.max(8, h)}px`;
}

// Escala da imagem exibida vs original (pra fonte manual acompanhar o zoom).
function fontScale() {
  const nat = elements.pageImage.naturalWidth || elements.pageImage.clientWidth || 1;
  return (elements.pageImage.clientWidth || nat) / nat;
}

// Recalcula a fonte de cada balão pelo tamanho REAL renderizado do nó
// (clientWidth/Height) — funciona em qualquer zoom. Se o balão tem fonte MANUAL
// (fontLocked), usa o tamanho escolhido (escalado pelo zoom) em vez do auto-ajuste.
function refitBoxFonts() {
  for (const node of elements.boxLayer.children) {
    const input = node.querySelector(".box-input");
    if (!input) continue;
    if (node.dataset.fontLocked === "1") {
      input.style.fontSize = `${Math.max(6, Math.round(Number(node.dataset.fontSize || 18) * fontScale()))}px`;
    } else {
      input.style.fontSize = `${fitBoxFont(input.value || input.placeholder, node.clientWidth, node.clientHeight)}px`;
    }
    autoSizeInput(input, node);
  }
}

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

    // Sinaliza pendencias da pagina na tira, pra revisar sem abrir cada uma:
    // ⚠ = alguma fala parece cortada; cinza = alguma fala ainda sem traducao.
    const boxes = state.project.pages[page.name]?.boxes || [];
    const hasTruncated = boxes.some((box) => box.translatedText && looksTruncated(box.originalText, box.translatedText));
    const hasPending = boxes.some((box) => !String(box.translatedText || "").trim());
    if (hasTruncated) {
      button.classList.add("page-warn");
      button.title = "Tem fala com traducao cortada — revisar";
      const warn = document.createElement("span");
      warn.className = "page-warn-icon";
      warn.textContent = " ⚠";
      button.append(warn);
    } else if (hasPending) {
      button.classList.add("page-pending");
      button.title = "Tem fala sem traducao ainda";
    }

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

  // Caixinhas numeradas compactas. Clique abre o detalhe (Original | Tradução).
  for (const box of boxes) {
    const orig = (box.originalText || "").trim();
    const trans = (box.translatedText || box.suggestedText || "").trim();

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "fala-chip";
    if (box.id === state.selectedBoxId) chip.classList.add("selected");
    chip.classList.add(trans ? "done" : "pending");

    // Traducao com cara de CORTADA (parou no meio da palavra, sem pontuacao
    // final) -- avisa na grade pra revisar sem precisar abrir cada balao.
    const truncated = Boolean(trans) && looksTruncated(orig, trans);
    if (truncated) chip.classList.add("truncated");

    chip.title = orig
      ? (trans ? `${orig}\n→ ${trans}` : `${orig}\n(sem traducao ainda)`)
      : "Caixa manual (sem texto detectado)";
    if (truncated) chip.title += "\n⚠ traducao parece cortada no meio da frase";

    const num = document.createElement("span");
    num.className = "chip-num";
    num.textContent = String(box.order).padStart(2, "0");

    const dot = document.createElement("span");
    dot.className = `conf-dot ${confClass(box.confidence)}`;
    dot.title = typeof box.confidence === "number"
      ? `Confianca: ${box.confidence}%`
      : "Caixa manual";

    chip.append(num, dot);

    if (truncated) {
      const warn = document.createElement("span");
      warn.className = "chip-warn";
      warn.textContent = "⚠";
      warn.title = "Traducao parece cortada no meio da frase";
      chip.append(warn);
    }

    chip.addEventListener("click", () => selectBox(box.id));
    elements.translationList.appendChild(chip);
  }
}

export function syncBoxForm() {
  const box = getSelectedBox();
  const disabled = !box;

  for (const field of [
    elements.boxType,
    elements.translatedText,
    elements.useSuggestion,
    elements.coverOriginal,
    elements.fontSize,
    elements.boxX,
    elements.boxY,
    elements.boxWidth,
    elements.boxHeight,
    elements.removeBox
  ]) {
    if (field) field.disabled = disabled;
  }

  if (!box) {
    elements.reviewTitle.textContent = "Revisão";
    elements.boxType.value = "fala";
    elements.originalText.value = "";
    elements.originalConf.textContent = "";
    elements.originalConf.className = "conf-badge";
    elements.suggestedPreview.textContent = "Selecione uma fala (clique num balão).";
    elements.useSuggestion.disabled = true;
    elements.translatedText.value = "";
    elements.coverOriginal.checked = true;
    elements.fontSize.value = "18";
    elements.fontWeight.value = "0";
    elements.boxX.value = "";
    elements.boxY.value = "";
    elements.boxWidth.value = "";
    elements.boxHeight.value = "";
    return;
  }

  elements.reviewTitle.textContent = `Fala ${String(box.order).padStart(2, "0")}`;
  elements.boxType.value = box.type || "fala";
  elements.originalText.value = box.originalText || "";
  if (typeof box.confidence === "number") {
    elements.originalConf.textContent = `${box.confidence}%`;
    elements.originalConf.className = `conf-badge ${confClass(box.confidence)}`;
  } else {
    elements.originalConf.textContent = "";
    elements.originalConf.className = "conf-badge";
  }
  elements.suggestedPreview.textContent = box.suggestedText
    ? `Sugestão: ${box.suggestedText}`
    : "Sem sugestão (use o botão Sugerir).";
  elements.useSuggestion.disabled = !box.suggestedText;
  elements.translatedText.value = box.translatedText || "";
  elements.coverOriginal.checked = box.coverOriginal !== false;
  elements.fontSize.value = box.fontSize || 18;
  elements.fontWeight.value = box.fontWeight || 0;
  elements.boxX.value = (box.x * 100).toFixed(1);
  elements.boxY.value = (box.y * 100).toFixed(1);
  elements.boxWidth.value = (box.width * 100).toFixed(1);
  elements.boxHeight.value = (box.height * 100).toFixed(1);
}

export function renderBoxes() {
  elements.boxLayer.innerHTML = "";

  const imgW = elements.pageImage.clientWidth || elements.pageImage.naturalWidth || 1;
  const imgH = elements.pageImage.clientHeight || elements.pageImage.naturalHeight || 1;

  for (const box of orderedBoxes()) {
    const node = document.createElement("div");
    node.className = "translation-box";
    node.classList.add(`type-${(box.type || "fala")}`);
    node.dataset.id = box.id;
    node.dataset.fontLocked = box.fontLocked ? "1" : "";
    node.dataset.fontSize = box.fontSize || 18;
    if (box.id === state.selectedBoxId) node.classList.add("selected");

    node.style.left = `${box.x * 100}%`;
    node.style.top = `${box.y * 100}%`;
    node.style.width = `${box.width * 100}%`;
    node.style.height = `${box.height * 100}%`;
    // Fundo da caixa é do CSS: BRANCA por padrão (cobre o inglês SEMPRE) e
    // transparente quando o fundo limpo (inpaint) carrega (.bg-clean no layer).
    // Inline só no caso "não cobrir o original" (o usuário PEDIU ver o de baixo).
    if (box.coverOriginal === false) node.style.background = "rgba(248, 252, 252, 0.20)";

    // Alça numerada (cor = confiança): clique seleciona, arraste move.
    const handle = document.createElement("div");
    handle.className = `box-handle ${confClass(box.confidence)}`;
    handle.textContent = String(box.order).padStart(2, "0");
    handle.title = "Arraste para mover";
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectBox(box.id);
      state.drag = {
        id: box.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: box.x,
        startY: box.y
      };
      handle.setPointerCapture(event.pointerId);
    });

    // Editor inline: digite a tradução final direto no balão.
    const input = document.createElement("textarea");
    input.className = "box-input";
    input.value = box.translatedText || "";
    input.placeholder = box.suggestedText || box.originalText || "traduzir...";
    input.style.fontSize = box.fontLocked
      ? `${Math.max(6, Math.round((box.fontSize || 18) * fontScale()))}px`
      : `${fitBoxFont(input.value || input.placeholder, box.width * imgW, box.height * imgH)}px`;
    // feedback ao vivo da GROSSURA (faux-bold) — escalado pro tamanho do editor
    input.style.webkitTextStroke = box.fontWeight
      ? `${(Number(box.fontWeight) * 0.15).toFixed(2)}px currentColor`
      : "";
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("focus", () => {
      if (state.selectedBoxId !== box.id) selectBox(box.id);
    });
    input.addEventListener("input", () => {
      box.translatedText = input.value;
      if (elements.translatedText) elements.translatedText.value = input.value;
      input.style.fontSize = `${fitBoxFont(input.value || input.placeholder, node.clientWidth, node.clientHeight)}px`;
      autoSizeInput(input, node);   // mantém centralizado ao digitar
      renderTranslationList();
    });

    node.append(handle, input);
    elements.boxLayer.appendChild(node);
  }

  // Agora que os balões estão no DOM, ajusta a fonte pelo tamanho real de cada um.
  refitBoxFonts();
  positionFloatTools();
}

export function renderCurrentPage() {
  const page = getCurrentPage();
  state.previewing = false;
  if (elements.previewPage) elements.previewPage.textContent = "Previa";
  renderPageList();

  if (!page) {
    for (const stage of [elements.viewerStage, elements.origStage]) {
      stage.classList.add("empty");
      stage.classList.remove("ready");
    }
    elements.pageImage.removeAttribute("src");
    elements.pageImageOriginal.removeAttribute("src");
    elements.boxLayer.innerHTML = "";
    renderTranslationList();
    syncBoxForm();
    setStatus("Selecione um capitulo na biblioteca.");
    setToolStatus("Abra uma pagina para comecar.");
    return;
  }

  for (const stage of [elements.viewerStage, elements.origStage]) {
    stage.classList.remove("empty");
    stage.classList.add("ready");
  }
  elements.pageImageOriginal.onload = () => applyZoom();
  elements.pageImageOriginal.src = page.url;
  elements.pageImage.onload = () => { applyZoom(); renderBoxes(); };
  // Fundo (ainda) é o ORIGINAL -> caixas BRANCAS cobrem o inglês até o fundo
  // limpo (inpaint) chegar via loadCleanBackground, que liga .bg-clean.
  elements.boxLayer?.classList.remove("bg-clean");
  elements.pageImage.src = page.url;

  normalizeBoxes();
  renderTranslationList();
  syncBoxForm();
  setStatus(`Pagina ${page.index + 1} de ${state.pages.length}`);
  setToolStatus(toolSummary());
  window.dispatchEvent(new CustomEvent("page-shown", { detail: { name: page.name } }));
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

// Barra de status do sistema: mostra de forma clara o que esta ativo
// (detector, OCR + GPU, e qual IA de traducao). Some a duvida "esta funcionando?".
const _OCR_NAMES = { easyocr: "EasyOCR", tesseract: "Tesseract", "manga-ocr": "MangaOCR", none: "—" };
export function renderSystemStatus() {
  const el = elements.systemStatus;
  if (!el) return;
  const det = state.tools?.bubbleDetector || {};
  const tr = state.tools?.translation || {};
  const provider = tr.provider || "local-basic";

  const pill = (cls, label, title) =>
    `<span class="sys-pill ${cls}" title="${title}"><span class="sys-dot"></span>${label}</span>`;

  // Detector de balões
  const det1 = det.yolo
    ? pill("on", "Detector", "YOLO carregado — detecta os balões")
    : pill("off", "Detector", det.pythonReady ? "Detector vai carregar no 1º uso" : "Detector indisponível (rode a venv do Python)");

  // OCR + GPU
  const ocrName = _OCR_NAMES[det.ocrEngine] || det.ocrEngine || "OCR";
  const ocrLabel = `${ocrName}${det.gpu ? " · GPU" : " · CPU"}`;
  const det2 = pill(det.ocrReady ? "on" : "warn", ocrLabel,
    det.gpu ? "OCR por IA, rodando na GPU (rápido)" : "OCR por IA, rodando na CPU");

  // Tradução (IA)
  let det3;
  if (provider === "ollama") {
    det3 = pill("on accent", `IA: ${tr.ollamaModel || "Ollama"}`, "Traduzindo com IA local (Ollama) — melhor qualidade");
  } else if (provider === "google") {
    det3 = pill("on", "Tradução: Google", "Tradutor Google (rápido, mais literal). Abra o Ollama p/ qualidade.");
  } else {
    det3 = pill("off", "Tradução: básica", "Sem IA nem Google — abra o Ollama ou verifique a conexão");
  }

  el.innerHTML = det1 + det2 + det3;
}

export function applyZoom() {
  const z = state.zoom || 1;
  // Usa o palco VISÍVEL (aba Original esconde o de tradução e vice-versa).
  const stage = elements.viewerStage?.clientHeight ? elements.viewerStage : elements.origStage;
  if (!stage || !stage.clientHeight) return;
  const h = Math.max(120, stage.clientHeight - 16);
  for (const img of [elements.pageImage, elements.pageImageOriginal]) {
    if (!img || !img.getAttribute("src")) continue;
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    img.style.width = "auto";
    img.style.height = `${Math.round(h * z)}px`;
  }
  refitBoxFonts();
  if (elements.zoomLabel) elements.zoomLabel.textContent = `${Math.round(z * 100)}%`;
  positionFloatTools();
}

export function selectBox(id) {
  state.selectedBoxId = id;
  // Atualiza a seleção sem recriar os balões nem MOVER a página (sem scrollIntoView).
  for (const node of elements.boxLayer.children) {
    node.classList.toggle("selected", node.dataset.id === id);
  }
  renderTranslationList();
  syncBoxForm();
  positionFloatTools();
}

export function addBox(values = {}) {
  const pageRecord = getCurrentPageRecord();
  if (!pageRecord) return null;

  const box = createBox(values);
  pageRecord.boxes.push(box);
  normalizeBoxes();
  state.selectedBoxId = box.id;
  renderBoxes();
  renderTranslationList();
  syncBoxForm();
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

// ===== Ações rápidas da fala selecionada (teclado, toolbar flutuante, roda) =====

// Move a fala selecionada sem recriar o DOM (rápido p/ segurar tecla/botão).
export function nudgeSelectedBox(dx, dy) {
  const box = getSelectedBox();
  if (!box) return false;
  box.x = clamp(box.x + dx, 0, 1 - box.width);
  box.y = clamp(box.y + dy, 0, 1 - box.height);
  const node = elements.boxLayer.querySelector(`.translation-box[data-id="${box.id}"]`);
  if (node) { node.style.left = `${box.x * 100}%`; node.style.top = `${box.y * 100}%`; }
  if (elements.boxX) elements.boxX.value = (box.x * 100).toFixed(1);
  if (elements.boxY) elements.boxY.value = (box.y * 100).toFixed(1);
  positionFloatTools();
  return true;
}

// Fonte da fala selecionada −/+ : parte do tamanho ATUAL (auto ou manual) e trava.
export function adjustSelectedFont(delta) {
  const box = getSelectedBox();
  if (!box) return false;
  let base = box.fontLocked ? Number(box.fontSize) || 0 : 0;
  if (!base) {
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

// ===== Toolbar FLUTUANTE junto do balão selecionado (A− A+ · setas · ⊕) =====
let _floatTools = null;
function ensureFloatTools() {
  const canvas = elements.pageImage?.parentElement;   // .page-canvas
  if (!canvas) return null;
  if (_floatTools && _floatTools.parentElement === canvas) return _floatTools;
  _floatTools = document.createElement("div");
  _floatTools.id = "float-tools";
  _floatTools.innerHTML = [
    '<button type="button" data-act="font-" title="Diminuir fonte (Q · roda do mouse)">A−</button>',
    '<button type="button" data-act="font+" title="Aumentar fonte (E · roda do mouse)">A+</button>',
    '<span class="ft-sep"></span>',
    '<button type="button" data-act="left" title="Mover p/ esquerda (A · Shift = rápido)">←</button>',
    '<button type="button" data-act="up" title="Mover p/ cima (W)">↑</button>',
    '<button type="button" data-act="down" title="Mover p/ baixo (S)">↓</button>',
    '<button type="button" data-act="right" title="Mover p/ direita (D)">→</button>',
    '<span class="ft-sep"></span>',
    '<button type="button" data-act="center" title="Re-centralizar os balões da página (R)">⊕</button>'
  ].join("");
  // Não deixa o clique virar "desenhar caixa nova" nem roubar a seleção.
  _floatTools.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
  _floatTools.addEventListener("click", (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 0.02 : 0.006;
    if (act === "font-") adjustSelectedFont(-1);
    else if (act === "font+") adjustSelectedFont(1);
    else if (act === "left") nudgeSelectedBox(-step, 0);
    else if (act === "up") nudgeSelectedBox(0, -step);
    else if (act === "down") nudgeSelectedBox(0, step);
    else if (act === "right") nudgeSelectedBox(step, 0);
    else if (act === "center") { renderCurrentPage(); setToolStatus("Balões re-centralizados nesta página."); }
  });
  canvas.appendChild(_floatTools);
  return _floatTools;
}

export function positionFloatTools() {
  const tools = ensureFloatTools();
  if (!tools) return;
  const node = elements.boxLayer?.querySelector(".translation-box.selected");
  if (!node) { tools.style.display = "none"; return; }
  tools.style.display = "flex";
  const w = tools.offsetWidth || 230;
  const h = tools.offsetHeight || 34;
  let left = node.offsetLeft + node.offsetWidth / 2 - w / 2;
  let top = node.offsetTop - h - 8;
  if (top < 2) top = node.offsetTop + node.offsetHeight + 8;   // sem espaço em cima: vai pra baixo
  const canvas = elements.pageImage?.parentElement;
  const maxLeft = (canvas?.clientWidth || 0) - w - 2;
  left = Math.max(2, Math.min(left, Math.max(2, maxLeft)));
  tools.style.left = `${left}px`;
  tools.style.top = `${top}px`;
}

// ===== Roda do mouse SOBRE o balão = fonte (Ctrl = fino, Shift = rápido) =====
elements.boxLayer?.addEventListener("wheel", (event) => {
  const node = event.target?.closest?.(".translation-box");
  if (!node) return;                       // fora de balão: rolagem normal da página
  event.preventDefault();                  // sobre o balão: a roda vira controle de fonte
  if (node.dataset.id !== state.selectedBoxId) selectBox(node.dataset.id);
  const dir = event.deltaY < 0 ? 1 : -1;
  const step = event.ctrlKey ? 1 : event.shiftKey ? 4 : 2;
  adjustSelectedFont(dir * step);
}, { passive: false });
