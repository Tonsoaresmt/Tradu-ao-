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

// Tradução automática da página atual (se ainda não tiver caixas): detecta +
// OCR + traduz e já aplica como tradução final, pro humano só revisar.
// Traduz UMA página específica (não "a atual"). Como detecção + tradução são
// assíncronas e demoradas, o usuário pode navegar enquanto roda; por isso tudo
// é escrito no registro DAQUELA página e só renderizamos se o usuário ainda
// estiver olhando para ela. Assim a tradução nunca "vaza" para a página errada
// e nenhuma página fica em branco por causa de corrida.
export async function autoTranslatePage(page) {
  page = page || getCurrentPage();
  if (!page) return false;

  const pages = state.project.pages || (state.project.pages = {});
  const record = pages[page.name] || (pages[page.name] = { boxes: [] });
  if (record.boxes && record.boxes.length) return false; // já processada

  const onThisPage = () => getCurrentPage()?.name === page.name;
  const status = (msg) => { if (onThisPage()) setToolStatus(msg); };

  status("Detectando os balões...");
  const result = await api("/api/ocr-page", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      page: page.name,
      ocr: elements.ocrEngine?.value
    })
  });
  if (!result.available || !Array.isArray(result.lines)) {
    status(result.message || "Detecção indisponível.");
    return false;
  }

  record.boxes = result.lines.map((line, index) => createBox({
    ...line,
    order: index + 1,
    suggestedText: "",
    translatedText: ""
  }));
  if (onThisPage()) {
    normalizeBoxes();
    renderCurrentPage(); // mostra os baloes posicionados + texto original JA
  }

  const toTranslate = record.boxes.filter((box) => box.originalText);
  if (!toTranslate.length) {
    status(`${record.boxes.length} balão(ões) detectado(s).`);
    return true;
  }

  status(`Traduzindo ${toTranslate.length} fala(s)...`);
  const nearby = record.boxes.map((box) => box.originalText).filter(Boolean);
  const sug = await api("/api/suggest-translation", {
    method: "POST",
    body: JSON.stringify({
      context: {
        manga: state.selectedManga,
        chapter: state.selectedChapter,
        page: page.name,
        nearbyLines: nearby
      },
      items: toTranslate.map((box) => ({ id: box.id, originalText: box.originalText }))
    })
  });
  const byId = new Map((sug.suggestions || []).map((s) => [s.id, s]));
  for (const box of toTranslate) {
    const s = byId.get(box.id);
    if (s?.text) {
      box.suggestedText = s.text;
      box.translatedText = s.text;
    }
  }

  // Qual motor traduziu de fato (pra deixar claro o que aconteceu).
  const provs = [...byId.values()].map((s) => s.provider || "").filter(Boolean);
  const motor = provs.some((p) => p.startsWith("ollama")) ? "IA (Ollama)"
    : provs.includes("google") ? "Google"
    : provs.some((p) => p === "memoria") ? "memória"
    : "básico";

  if (onThisPage()) renderCurrentPage();
  status(`✓ Página traduzida com ${motor}: ${record.boxes.length} fala(s). Revise o que precisar.`);
  return true;
}

function bestOverlap(box, oldBoxes) {
  let best = null;
  let bestArea = 0;
  const ax2 = box.x + box.width;
  const ay2 = box.y + box.height;
  for (const o of oldBoxes) {
    const ix = Math.max(0, Math.min(ax2, o.x + o.width) - Math.max(box.x, o.x));
    const iy = Math.max(0, Math.min(ay2, o.y + o.height) - Math.max(box.y, o.y));
    const inter = ix * iy;
    if (inter > bestArea) {
      bestArea = inter;
      best = o;
    }
  }
  return bestArea > 0 ? best : null;
}

// Auto Organizar: redetecta os balões da página (caixas justas) e preserva as
// traduções, casando cada balão novo com o antigo mais sobreposto.
export async function autoOrganize() {
  const page = getCurrentPage();
  if (!page) {
    setToolStatus("Abra uma pagina antes de auto organizar.");
    return;
  }

  setToolStatus("Auto organizando (redetectando baloes)...");
  const result = await api("/api/ocr-page", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      page: page.name,
      ocr: elements.ocrEngine?.value
    })
  });

  if (!result.available || !Array.isArray(result.lines) || !result.lines.length) {
    setToolStatus(result.message || "Nenhum balao detectado.");
    return;
  }

  const oldBoxes = getCurrentPageRecord().boxes || [];
  const newBoxes = result.lines.map((line, index) => {
    const box = createBox({ ...line, order: index + 1, suggestedText: "", translatedText: "" });
    const match = bestOverlap(box, oldBoxes);
    if (match) {
      box.translatedText = match.translatedText || "";
      box.suggestedText = match.suggestedText || "";
    }
    return box;
  });

  getCurrentPageRecord().boxes = newBoxes;
  state.selectedBoxId = newBoxes[0]?.id || null;
  normalizeBoxes();
  renderCurrentPage();
  const kept = newBoxes.filter((box) => box.translatedText || box.suggestedText).length;
  setToolStatus(`Auto organizado: ${newBoxes.length} balao(oes) reposicionado(s), ${kept} traducao(oes) preservada(s).`);
}
