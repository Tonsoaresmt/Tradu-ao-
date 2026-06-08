// Ações de OCR e tradução: detectar falas, sugerir, aplicar e copiar.
import { state, elements } from "./state.js";
import { api } from "./api.js";
import {
  getCurrentPage,
  getCurrentPageRecord,
  createBox,
  orderedBoxes,
  normalizeBoxes,
  renderCurrentPage,
  setToolStatus
} from "./editor.js";

export async function runOcr() {
  const page = getCurrentPage();
  if (!page) return;

  setToolStatus("Detectando textos...");
  const result = await api("/api/ocr-page", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      page: page.name,
      ocr: elements.ocrEngine?.value
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

export async function suggestPage() {
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

export function applySuggestions() {
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

export function acceptConfident(threshold = 90) {
  let applied = 0;
  for (const page of Object.values(state.project.pages || {})) {
    for (const box of page.boxes || []) {
      if (!box.translatedText && box.suggestedText
        && typeof box.confidence === "number" && box.confidence >= threshold) {
        box.translatedText = box.suggestedText;
        applied++;
      }
    }
  }
  renderCurrentPage();
  setToolStatus(`${applied} sugestao(oes) com confianca >= ${threshold}% aceitas no capitulo. Salve para confirmar.`);
}

export async function copyOriginals() {
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
