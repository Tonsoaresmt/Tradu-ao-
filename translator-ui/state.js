// Estado compartilhado, referências do DOM e utilitários puros.
export const state = {
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

export const elements = {
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
  origStage: document.querySelector("#orig-stage"),
  pageImage: document.querySelector("#page-image"),
  pageImageOriginal: document.querySelector("#page-image-original"),
  boxLayer: document.querySelector("#box-layer"),
  reloadLibrary: document.querySelector("#reload-library"),
  saveProject: document.querySelector("#save-project"),
  exportChapter: document.querySelector("#export-chapter"),
  preprocessChapter: document.querySelector("#preprocess-chapter"),
  previewPage: document.querySelector("#preview-page"),
  ocrEngine: document.querySelector("#ocr-engine"),
  prevPage: document.querySelector("#prev-page"),
  nextPage: document.querySelector("#next-page"),
  addLine: document.querySelector("#add-line"),
  runOcr: document.querySelector("#run-ocr"),
  suggestPage: document.querySelector("#suggest-page"),
  applySuggestions: document.querySelector("#apply-suggestions"),
  copyOriginals: document.querySelector("#copy-originals"),
  acceptConfident: document.querySelector("#accept-confident"),
  toolStatus: document.querySelector("#tool-status"),
  translationList: document.querySelector("#translation-list"),
  lineCounter: document.querySelector("#line-counter"),
  removeBox: document.querySelector("#remove-box"),
  reviewTitle: document.querySelector("#review-title"),
  originalText: document.querySelector("#original-text"),
  originalConf: document.querySelector("#original-conf"),
  suggestedPreview: document.querySelector("#suggested-preview"),
  useSuggestion: document.querySelector("#use-suggestion"),
  translatedText: document.querySelector("#translated-text"),
  coverOriginal: document.querySelector("#cover-original"),
  fontSize: document.querySelector("#font-size"),
  boxX: document.querySelector("#box-x"),
  boxY: document.querySelector("#box-y"),
  boxWidth: document.querySelector("#box-width"),
  boxHeight: document.querySelector("#box-height")
};

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function makeId() {
  return `line-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}
