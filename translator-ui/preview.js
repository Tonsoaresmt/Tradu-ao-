// Prévia da página: renderiza (inpaint + typeset) a página atual e mostra na tela.
import { state, elements } from "./state.js";
import { api } from "./api.js";
import { getCurrentPage, orderedBoxes, renderCurrentPage, setToolStatus } from "./editor.js";

export async function previewPage() {
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
    type: box.type || "fala",
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

  // Veredito do REVISOR (QC): fonte/centralizacao/encaixe fora do padrao.
  const issues = Array.isArray(result.qcIssues) ? result.qcIssues : [];
  if (issues.length) {
    const amostra = issues.slice(0, 4).map((i) => `balão ${i.box}: ${i.problems.join("; ")}`).join(" | ");
    setToolStatus(`Prévia: ${result.boxesRendered} fala(s). ⚠ Revisor apontou ${issues.length}: ${amostra}. 'Editar' p/ voltar.`);
  } else {
    setToolStatus(`Prévia: ${result.boxesRendered} fala(s) — revisor OK ✅. 'Editar' p/ voltar.`);
  }
}
