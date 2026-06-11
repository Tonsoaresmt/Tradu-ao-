// Ações de OCR e tradução: detectar falas, sugerir, aplicar e copiar.
import { state, elements } from "./state.js";
import { api } from "./api.js";
import {
  getCurrentPage,
  getCurrentPageRecord,
  getSelectedBox,
  createBox,
  orderedBoxes,
  normalizeBoxes,
  renderCurrentPage,
  setToolStatus
} from "./editor.js";

// === Fundo limpo do editor (inpaint: ingles removido, rosto/arte preservados) ===
// O editor passa a mostrar a pagina JA com o inpaint, em vez da original. Assim a
// caixa de fala NAO precisa tapar nada (fica transparente) -> nao cobre o rosto.
const _cleanBgCache = new Map();   // pageName -> dataUrl

export function invalidateCleanBg(pageName) {
  if (pageName) _cleanBgCache.delete(pageName);
  else _cleanBgCache.clear();
  // fundo volta a ser o original -> caixas voltam a ser BRANCAS (cobrem o EN)
  elements.boxLayer?.classList.remove("bg-clean");
}

export async function loadCleanBackground() {
  if (state.previewing) return;               // a Previa controla a imagem
  const page = getCurrentPage();
  if (!page || !state.selectedManga) return;
  const boxes = state.project.pages?.[page.name]?.boxes || [];
  if (!boxes.length) return;                  // sem baloes ainda -> mantem original
  const key = page.name;

  const apply = (dataUrl) => {
    if (getCurrentPage()?.name === key && !state.previewing && dataUrl) {
      elements.pageImage.src = dataUrl;       // troca o fundo da aba Traducao
      // fundo limpo no lugar -> caixas podem ficar transparentes (fiel ao render)
      elements.boxLayer?.classList.add("bg-clean");
    }
  };

  if (_cleanBgCache.has(key)) { apply(_cleanBgCache.get(key)); return; }

  try {
    const data = await api("/api/preview-page", {
      method: "POST",
      body: JSON.stringify({
        manga: state.selectedManga,
        chapter: state.selectedChapter,
        page: page.name,
        typeset: false,                       // so inpaint
        boxes: boxes.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height, type: b.type, coverOriginal: b.coverOriginal }))
      })
    });
    if (data?.dataUrl) { _cleanBgCache.set(key, data.dataUrl); apply(data.dataUrl); }
  } catch (error) {
    // Caixas seguem BRANCAS cobrindo o EN (seguro). Avisa pra diagnosticar.
    setToolStatus(`Fundo limpo indisponível (${error.message}) — caixas cobrindo o original.`);
  }
}

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

// Re-traduz UMA fala com o texto original ATUAL (que o humano pode ter corrigido
// no campo editável). Resolve erro de OCR sem precisar criar caixa nova.
export async function retranslateBox() {
  const box = getSelectedBox();
  if (!box) { setToolStatus("Selecione uma fala primeiro."); return; }
  const original = String(box.originalText || "").trim();
  if (!original) { setToolStatus("Sem texto original para traduzir (corrija o campo Original)."); return; }
  setToolStatus("Re-traduzindo esta fala...");
  const result = await api("/api/suggest-translation", {
    method: "POST",
    body: JSON.stringify({
      context: {
        manga: state.selectedManga,
        chapter: state.selectedChapter,
        page: getCurrentPage()?.name,
        nearbyLines: orderedBoxes().map((b) => b.originalText).filter(Boolean)
      },
      items: [{ id: box.id, originalText: original }]
    })
  });
  const s = (result.suggestions || [])[0];
  if (s?.text) {
    box.suggestedText = s.text;
    box.translatedText = s.text;
    invalidateCleanBg(getCurrentPage()?.name);
    renderCurrentPage();
    setToolStatus(`Re-traduzido: ${s.text}`);
  } else {
    setToolStatus("A IA não retornou tradução (o Ollama está aberto?).");
  }
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
  // NÃO auto-encurtar: o encurtamento automático quebrava a gramática ("está"->"é",
  // "sede"->"sedi"). A tradução do modelo fica como está (boa) e a FONTE só diminui
  // pra caber. (autoFitCurrentPage continua disponível como ação manual opcional.)
  return true;
}

// Loop de QC fechado (lado do cliente): manda a pagina pro /api/autofit-page,
// que renderiza, vê quais falas NÃO couberam e pede pro Ollama ENCURTAR — repete
// até passar. Roda em background pra não atrasar a exibição da tradução.
export async function autoFitCurrentPage(page, record) {
  if (!record?.boxes?.length || !state.selectedManga) return;
  try {
    const fit = await api("/api/autofit-page", {
      method: "POST",
      body: JSON.stringify({
        manga: state.selectedManga,
        chapter: state.selectedChapter,
        page: page.name,
        boxes: record.boxes.map((b) => ({
          id: b.id, x: b.x, y: b.y, width: b.width, height: b.height,
          type: b.type, order: b.order, translatedText: b.translatedText, coverOriginal: b.coverOriginal
        }))
      })
    });
    if (!fit?.boxes) return;
    const fitById = new Map(fit.boxes.map((f) => [f.id, f.translatedText]));
    let changed = false;
    for (const b of record.boxes) {
      const nv = fitById.get(b.id);
      if (nv != null && nv !== b.translatedText) { b.translatedText = nv; changed = true; }
    }
    if (changed && getCurrentPage()?.name === page.name) renderCurrentPage();
  } catch {
    /* best-effort */
  }
}

// Botao "Revisar (9b)": manda original+rascunho da pagina pro modelo MAIOR revisar
// e corrigir. Aplica so o que ele mudou (e re-renderiza). O 9b carrega na hora
// (troca de modelo) — demora, mas e sob demanda.
export async function reviewPage() {
  const page = getCurrentPage();
  const record = getCurrentPageRecord();
  if (!page || !record?.boxes?.length) {
    setToolStatus("Abra uma página com falas antes de revisar.");
    return;
  }
  const toReview = record.boxes.filter((b) => String(b.translatedText || "").trim());
  if (!toReview.length) {
    setToolStatus("Nada traduzido nesta página para revisar.");
    return;
  }
  setToolStatus("Revisando com o modelo maior (carrega o 9b, pode demorar)...");
  const data = await api("/api/review-page", {
    method: "POST",
    body: JSON.stringify({
      manga: state.selectedManga,
      chapter: state.selectedChapter,
      page: page.name,
      boxes: record.boxes.map((b) => ({ id: b.id, originalText: b.originalText, translatedText: b.translatedText }))
    })
  });
  const byId = new Map((data.boxes || []).map((r) => [r.id, r]));
  let changed = 0;
  for (const b of record.boxes) {
    const r = byId.get(b.id);
    if (r && r.changed && String(r.translatedText || "").trim()) {
      b.translatedText = r.translatedText;
      changed += 1;
    }
  }
  if (getCurrentPage()?.name === page.name) renderCurrentPage();
  setToolStatus(`✓ Revisor (${data.model || "9b"}): ${changed} de ${toReview.length} fala(s) ajustada(s).`);
}

// Botao "Re-traduzir do zero": apaga os baloes desta pagina e detecta+traduz de
// novo (pra ver o efeito de mudancas sem zerar a obra toda). Substitui edicoes.
export async function retranslatePage() {
  const page = getCurrentPage();
  const record = getCurrentPageRecord();
  if (!page || !record) {
    setToolStatus("Abra uma página antes.");
    return;
  }
  if ((record.boxes || []).length &&
      !window.confirm("Re-traduzir esta página do zero? As traduções/edições DESTA página serão substituídas.")) {
    return;
  }
  record.boxes = [];
  state.selectedBoxId = null;
  invalidateCleanBg(page.name);
  renderCurrentPage();
  setToolStatus("Re-traduzindo esta página do zero...");
  await autoTranslatePage(page);   // re-detecta + traduz limpo (boxes vazias -> roda)
  loadCleanBackground();
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
  invalidateCleanBg(page.name);   // baloes mudaram -> refaz o fundo limpo
  renderCurrentPage();
  loadCleanBackground();
  const kept = newBoxes.filter((box) => box.translatedText || box.suggestedText).length;
  setToolStatus(`Auto organizado: ${newBoxes.length} balao(oes) reposicionado(s), ${kept} traducao(oes) preservada(s).`);
}
