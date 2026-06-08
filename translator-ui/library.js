// Biblioteca de mangás/capítulos, abertura de capítulo e gravação do projeto.
import { state, elements } from "./state.js";
import { api } from "./api.js";
import { renderCurrentPage, setStatus, setToolStatus, toolSummary, renderSystemStatus } from "./editor.js";
import { markChapterSaved } from "./autosave.js";

export function renderFolders(folders) {
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

export function renderLibrary() {
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

export async function loadLibrary() {
  elements.libraryStatus.textContent = "Lendo mangas...";

  try {
    const data = await api("/api/library");
    state.library = data.mangas;
    state.tools = data.tools;
    renderFolders(data.folders);
    renderLibrary();
    renderSystemStatus();
    setToolStatus(toolSummary());
  } catch (error) {
    elements.libraryStatus.textContent = error.message;
  }
}

export async function openChapter(manga, chapter) {
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
    markChapterSaved();
  } catch (error) {
    elements.chapterTitle.textContent = "Nenhum capitulo aberto";
    elements.chapterSubtitle.textContent = "Abra um capitulo para revisar as falas por pagina.";
    elements.pageSource.textContent = "Aguardando capitulo.";
    setStatus(error.message);
  }
}

export async function saveProject() {
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

  markChapterSaved();
  const trained = result.training?.updated || 0;
  setStatus(trained
    ? `Projeto salvo. ${trained} exemplo(s) adicionados ao treino.`
    : "Projeto salvo.");
}
