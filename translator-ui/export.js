// Geração do capítulo final (CBZ) e fila de pré-processamento por capítulo.
import { state, elements } from "./state.js";
import { api } from "./api.js";
import { setStatus, setToolStatus } from "./editor.js";
import { saveProject, openChapter } from "./library.js";

export async function exportChapter() {
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

export async function preprocessChapter() {
  if (!state.selectedManga || !state.selectedChapter) {
    setStatus("Abra um capitulo antes de pre-processar.");
    return;
  }

  setToolStatus("Iniciando pre-processamento do capitulo...");
  const start = await api("/api/preprocess-chapter", {
    method: "POST",
    body: JSON.stringify({ manga: state.selectedManga, chapter: state.selectedChapter, ocr: elements.ocrEngine?.value })
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
