const state = {
  library: [],
  tools: null,
  selectedManga: null,
  selectedChapter: null,
  pages: [],
  project: { pages: {} },
  currentPageIndex: 0,
  selectedBoxId: null,
  drag: null,
  draw: null,
  previewing: false
};

const elements = {
  libraryStatus: document.querySelector("#library-status"),
  libraryList: document.querySelector("#library-list"),
  folderInfo: document.querySelector("#folder-info"),
  chapterTitle: document.querySelector("#chapter-title"),
  chapterSubtitle: document.querySelector("#chapter-subtitle"),
  pageMeta: document.querySelector("#page-meta"),
  pageCounter: document.querySelector("#page-counter"),
  pageSource: document.querySelector("#page-source"),
  pageList: document.querySelector("#page-list"),
  viewerStage: document.querySelector("#viewer-stage"),
  pageImage: document.querySelector("#page-image"),
  boxLayer: document.querySelector("#box-layer"),
  reloadLibrary: document.querySelector("#reload-library"),
  saveProject: document.querySelector("#save-project"),
  exportChapter: document.querySelector("#export-chapter"),
  preprocessChapter: document.querySelector("#preprocess-chapter"),
  previewPage: document.querySelector("#preview-page"),
  prevPage: document.querySelector("#prev-page"),
  nextPage: document.querySelector("#next-page"),
  addLine: document.querySelector("#add-line"),
  runOcr: document.querySelector("#run-ocr"),
  suggestPage: document.querySelector("#suggest-page"),
  applySuggestions: document.querySelector("#apply-suggestions"),
  copyOriginals: document.querySelector("#copy-originals"),
  toolStatus: document.querySelector("#tool-status"),
  translationList: document.querySelector("#translation-list"),
  lineCounter: document.querySelector("#line-counter"),
  removeBox: document.querySelector("#remove-box"),
  originalText: document.querySelector("#original-text"),
  suggestedText: document.querySelector("#suggested-text"),
  translatedText: document.querySelector("#translated-text"),
  coverOriginal: document.querySelector("#cover-original"),
  fontSize: document.querySelector("#font-size"),
  boxX: document.querySelector("#box-x"),
  boxY: document.querySelector("#box-y"),
  boxWidth: document.querySelector("#box-width"),
  boxHeight: document.querySelector("#box-height")
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function makeId() {
  return `line-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Erro inesperado" }));
    throw new Error(error.error || "Erro inesperado");
  }

  return response.json();
}

function getCurrentPage() {
  return state.pages[state.currentPageIndex] || null;
}

function getCurrentPageRecord() {
  const page = getCurrentPage();
  if (!page) return null;

  if (!state.project.pages[page.name]) {
    state.project.pages[page.name] = { boxes: [] };
  }

  state.project.pages[page.name].boxes ||= [];
  return state.project.pages[page.name];
}

function orderedBoxes() {
  const pageRecord = getCurrentPageRecord();
  if (!pageRecord) return [];

  return [...pageRecord.boxes].sort((a, b) => (
    (a.order ?? 9999) - (b.order ?? 9999) ||
    (a.y ?? 0) - (b.y ?? 0) ||
    (a.x ?? 0) - (b.x ?? 0)
  ));
}

function getSelectedBox() {
  return orderedBoxes().find((box) => box.id === state.selectedBoxId) || null;
}

function setStatus(message) {
  elements.pageMeta.textContent = message;
}

function setToolStatus(message) {
  elements.toolStatus.textContent = message;
}

function createBox(values = {}) {
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

function normalizeBoxes() {
  orderedBoxes().forEach((box, index) => {
    box.order = index + 1;
  });
}

function renderLibrary() {
  elements.libraryList.innerHTML = "";

  if (!state.library.length) {
    elements.libraryStatus.textContent = "Nenhum capitulo encontrado na pasta de entrada.";
    return;
  }

  elements.libraryStatus.textContent = `${state.library.length} manga(s) disponivel(is).`;

  for (const manga of state.library) {
    const card = document.createElement("article");
    card.className = "manga-card";

    const title = document.createElement("h3");
    title.textContent = manga.name;

    const info = document.createElement("p");
    info.className = "muted small";
    info.textContent = `${manga.chapters.length} capitulo(s).`;

    const chapterList = document.createElement("div");
    chapterList.className = "chapter-list";

    for (const chapter of manga.chapters) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chapter-button";

      if (state.selectedManga === manga.name && state.selectedChapter === chapter.name) {
        button.classList.add("active");
      }

      const chapterTitle = document.createElement("span");
      chapterTitle.textContent = chapter.name;

      const meta = document.createElement("span");
      meta.className = "chapter-meta";

      const statusBadge = document.createElement("span");
      statusBadge.className = `chapter-badge ${chapter.status === "ready" ? "ready" : "pending"}`;
      statusBadge.textContent = chapter.status === "ready" ? "Pronto" : "CBZ";

      const pageInfo = document.createElement("span");
      pageInfo.textContent = chapter.pageCount ? `${chapter.pageCount} pags` : "preparar";

      meta.append(statusBadge, pageInfo);
      button.append(chapterTitle, meta);
      button.addEventListener("click", () => openChapter(manga.name, chapter.name));
      chapterList.appendChild(button);
    }

    card.append(title, info, chapterList);
    elements.libraryList.appendChild(card);
  }
}

function renderFolders(folders) {
  elements.folderInfo.innerHTML = "";
  if (!folders) return;

  for (const item of [
    { label: "Entrada", value: folders.source },
    { label: "Paginas", value: folders.pages },
    { label: "Projeto", value: folders.projects },
    { label: "Saida", value: folders.output }
  ]) {
    const chip = document.createElement("div");
    chip.className = "folder-chip";
    chip.textContent = `${item.label}: ${item.value}`;
    elements.folderInfo.appendChild(chip);
  }
}

function renderPageList() {
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

function renderTranslationList() {
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
    item.append(number, content);
    item.addEventListener("click", () => selectBox(box.id));
    elements.translationList.appendChild(item);
  }
}

function syncBoxForm() {
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

function renderBoxes() {
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

function renderCurrentPage() {
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

function toolSummary() {
  const hasLocalOcr = state.tools?.ocr?.available || state.tools?.ocr?.providers?.windows;
  const ocr = hasLocalOcr
    ? "OCR local pronto"
    : state.tools?.ocr?.providers?.openaiConfigured
      ? "OCR por IA externa habilitado"
      : "OCR indisponivel";
  const provider = state.tools?.translation?.provider || "local-basic";
  return `${ocr}. Sugestao: ${provider}.`;
}

function selectBox(id) {
  state.selectedBoxId = id;
  renderBoxes();
  renderTranslationList();
  syncBoxForm();
}

function addBox(values = {}) {
  const pageRecord = getCurrentPageRecord();
  if (!pageRecord) return null;

  const box = createBox(values);
  pageRecord.boxes.push(box);
  normalizeBoxes();
  selectBox(box.id);
  return box;
}

function startDraw(event) {
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

function updateSelectedBox(patch) {
  const box = getSelectedBox();
  if (!box) return;

  Object.assign(box, patch);
  renderBoxes();
  renderTranslationList();
}

async function loadLibrary() {
  elements.libraryStatus.textContent = "Lendo mangas...";

  try {
    const data = await api("/api/library");
    state.library = data.mangas;
    state.tools = data.tools;
    renderFolders(data.folders);
    renderLibrary();
    setToolStatus(toolSummary());
  } catch (error) {
    elements.libraryStatus.textContent = error.message;
  }
}

async function openChapter(manga, chapter) {
  elements.chapterTitle.textContent = "Abrindo capitulo...";
  elements.chapterSubtitle.textContent = "Preparando paginas.";
  elements.pageSource.textContent = "Carregando...";
  setStatus("Carregando paginas...");

  try {
    const data = await api(`/api/chapter?manga=${encodeURIComponent(manga)}&chapter=${encodeURIComponent(chapter)}`);
    state.selectedManga = manga;
    state.selectedChapter = chapter;
    state.pages = data.pages;
    state.project = data.project || { manga, chapter, pages: {} };
    state.project.manga = manga;
    state.project.chapter = chapter;
    state.project.pages ||= {};
    state.currentPageIndex = 0;
    state.selectedBoxId = null;

    elements.chapterTitle.textContent = `${manga} / ${chapter}`;
    elements.chapterSubtitle.textContent = data.sourceType === "cbz"
      ? "CBZ extraido para revisao."
      : "Capitulo em imagens.";
    elements.pageSource.textContent = data.sourceType === "cbz"
      ? "Fonte: CBZ preparado localmente"
      : "Fonte: pasta de imagens";
    renderLibrary();
    renderCurrentPage();
  } catch (error) {
    elements.chapterTitle.textContent = "Nenhum capitulo aberto";
    elements.chapterSubtitle.textContent = "Abra um capitulo para revisar as falas por pagina.";
    elements.pageSource.textContent = "Aguardando capitulo.";
    setStatus(error.message);
  }
}

async function saveProject() {
  if (!state.selectedManga || !state.selectedChapter) {
    setStatus("Abra um capitulo antes de salvar.");
    return;
  }

  const result = await api("/api/project", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      pages: state.project.pages
    })
  });

  const trained = result.training?.updated || 0;
  setStatus(trained
    ? `Projeto salvo. ${trained} exemplo(s) adicionados ao treino.`
    : "Projeto salvo.");
}

async function exportChapter() {
  if (!state.selectedManga || !state.selectedChapter) {
    setStatus("Abra um capitulo antes de gerar.");
    return;
  }

  await saveProject();
  setStatus("Gerando capitulo traduzido (inpaint + typeset)... pode levar um tempo.");

  const result = await api("/api/export", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      format: "cbz"
    })
  });

  const where = result.cbz || result.outputDir;
  setStatus(`Capitulo gerado: ${result.pages} pagina(s), ${result.boxesRendered} fala(s) typeset. Saida: ${where}`);
}

async function preprocessChapter() {
  if (!state.selectedManga || !state.selectedChapter) {
    setStatus("Abra um capitulo antes de pre-processar.");
    return;
  }

  setToolStatus("Iniciando pre-processamento do capitulo...");
  const start = await api("/api/preprocess-chapter", {
    method: "POST",
    body: JSON.stringify({ manga: state.selectedManga, chapter: state.selectedChapter })
  });

  const jobId = start.jobId;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const job = await api(`/api/job?id=${encodeURIComponent(jobId)}`);

    if (job.status === "running") {
      setToolStatus(`Pre-processando ${job.done}/${job.total || "?"}${job.current ? ` (${job.current})` : ""}...`);
      continue;
    }

    if (job.status === "error") {
      setToolStatus(`Erro no pre-processo: ${job.error}`);
      return;
    }

    setToolStatus(`Capitulo pre-processado: ${job.detectedBoxes} fala(s), ${job.suggested} sugerida(s)${job.skipped ? `, ${job.skipped} pag. ja feitas mantidas` : ""}. Recarregando...`);
    await openChapter(state.selectedManga, state.selectedChapter);
    return;
  }
}

async function previewPage() {
  const page = getCurrentPage();
  if (!page) {
    setToolStatus("Abra uma pagina antes da previa.");
    return;
  }

  if (state.previewing) {
    state.previewing = false;
    renderCurrentPage();
    return;
  }

  setToolStatus("Gerando previa da pagina (inpaint + typeset)...");
  const boxes = orderedBoxes().map((box) => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    translatedText: box.translatedText || box.suggestedText || "",
    coverOriginal: box.coverOriginal !== false
  }));

  const result = await api("/api/preview-page", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      page: page.name,
      boxes
    })
  });

  state.previewing = true;
  elements.previewPage.textContent = "Editar";
  elements.pageImage.onload = null;
  elements.pageImage.src = result.dataUrl;
  elements.boxLayer.innerHTML = "";
  setToolStatus(`Previa: ${result.boxesRendered} fala(s) renderizada(s). Clique 'Editar' para voltar.`);
}

async function runOcr() {
  const page = getCurrentPage();
  if (!page) return;

  setToolStatus("Detectando textos...");
  const result = await api("/api/ocr-page", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      page: page.name
    })
  });

  if (!result.available) {
    setToolStatus(result.message || "OCR indisponivel.");
    return;
  }

  const pageRecord = getCurrentPageRecord();
  pageRecord.boxes = result.lines.map((line, index) => createBox({
    ...line,
    order: index + 1,
    suggestedText: "",
    translatedText: ""
  }));
  state.selectedBoxId = pageRecord.boxes[0]?.id || null;
  normalizeBoxes();
  renderCurrentPage();
  setToolStatus(result.message || `${result.lines.length} fala(s) detectada(s) por ${result.provider}.`);
}

async function suggestPage() {
  const boxes = orderedBoxes().filter((box) => box.originalText);
  if (!boxes.length) {
    setToolStatus("Nao ha texto original para sugerir.");
    return;
  }

  setToolStatus("Gerando sugestoes...");
  const result = await api("/api/suggest-translation", {
    method: "POST",
    body: JSON.stringify({
      context: {
        manga: state.selectedManga,
        chapter: state.selectedChapter,
        page: getCurrentPage()?.name,
        nearbyLines: orderedBoxes().map((box) => box.originalText).filter(Boolean)
      },
      items: boxes.map((box) => ({
        id: box.id,
        originalText: box.originalText
      }))
    })
  });

  const byId = new Map(result.suggestions.map((item) => [item.id, item]));
  for (const box of boxes) {
    const suggestion = byId.get(box.id);
    if (suggestion?.text) box.suggestedText = suggestion.text;
  }

  renderCurrentPage();
  setToolStatus(`${boxes.length} sugestao(oes) atualizada(s).`);
}

async function copyOriginals() {
  const text = orderedBoxes()
    .map((box) => `${String(box.order).padStart(2, "0")}. ${box.originalText || ""}`)
    .join("\n")
    .trim();

  if (!text) {
    setToolStatus("Nao ha textos para copiar.");
    return;
  }

  await navigator.clipboard.writeText(text);
  setToolStatus("Textos originais copiados.");
}

function applySuggestions() {
  let applied = 0;

  for (const box of orderedBoxes()) {
    if (!box.translatedText && box.suggestedText) {
      box.translatedText = box.suggestedText;
      applied++;
    }
  }

  renderCurrentPage();
  setToolStatus(`${applied} sugestao(oes) aplicada(s).`);
}

function handlePointerMove(event) {
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

function handlePointerUp(event) {
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
