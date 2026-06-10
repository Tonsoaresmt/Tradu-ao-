// Referência do estúdio (por obra): upload da tradução profissional + botão
// "Aprender estilo" (OCR em PT da amostra -> a IA destila um perfil de estilo
// que entra no prompt de TODA tradução da obra). Painel na barra lateral.
import { state, elements } from "./state.js";

let lastManga = null;

function setRefStatus(text) {
  if (elements.referenceStatus) elements.referenceStatus.textContent = text;
}

export async function refreshReferenceInfo() {
  const manga = state.selectedManga;
  if (!manga) {
    setRefStatus("Abra um capítulo primeiro.");
    return;
  }
  try {
    const res = await fetch(`/api/reference?manga=${encodeURIComponent(manga)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "erro");
    const ref = data.pages
      ? `${data.pages} pág(s) de referência`
      : "sem referência ainda";
    const perfil = data.profile
      ? ` · perfil aprendido ✓ (${data.learnedPages} págs)`
      : " · perfil: —";
    setRefStatus(`${manga}: ${ref}${perfil}`);
    // Relatório de aprendizado: mostra O QUE a IA destilou da referência.
    if (elements.profileDetails && elements.profileText) {
      const temVisual = data.visual && data.visual.fontFrac;
      if (data.profile || temVisual) {
        const partes = [];
        if (data.profile) partes.push(data.profile);
        if (temVisual) {
          const pctFonte = (data.visual.fontFrac * 100).toFixed(1);
          const pctEnche = data.visual.fillMedian ? `${Math.round(data.visual.fillMedian * 100)}%` : "—";
          partes.push(`Estilo visual aprendido (de ${data.visual.pages} pág.): fonte típica ≈ ${pctFonte}% da altura da página · preenchimento ≈ ${pctEnche}.`);
        }
        if (data.profile) {
          const quando = data.learnedAt ? new Date(data.learnedAt).toLocaleString("pt-BR") : "—";
          partes.push(`— Aprendido de ${data.learnedPages} página(s) · ${data.learnedFalas || "?"} fala(s) lida(s) · ${quando}`);
        }
        elements.profileText.textContent = partes.join("\n\n");
        elements.profileDetails.hidden = false;
      } else {
        elements.profileDetails.hidden = true;
      }
    }
  } catch (error) {
    setRefStatus(`Não consegui ler a referência: ${error.message}`);
  }
}

async function uploadReferenceFiles(files) {
  const manga = state.selectedManga;
  if (!manga) {
    setRefStatus("Abra um capítulo da obra antes de enviar a referência.");
    return;
  }
  let enviados = 0;
  for (const file of files) {
    setRefStatus(`Enviando ${file.name} (${Math.round(file.size / 1048576)} MB)...`);
    const res = await fetch(
      `/api/reference-upload?manga=${encodeURIComponent(manga)}&name=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setRefStatus(`Falha em ${file.name}: ${data?.error || res.status}`);
      return;
    }
    enviados += 1;
  }
  if (enviados) await refreshReferenceInfo();
}

async function learnStyleNow() {
  const manga = state.selectedManga;
  if (!manga) {
    setRefStatus("Abra um capítulo da obra antes de aprender o estilo.");
    return;
  }
  elements.learnStyle.disabled = true;
  try {
    const res = await fetch("/api/learn-style", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manga })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setRefStatus(`Aprendendo o estilo (${data.pages} págs de referência)...`);
    // poll do job até terminar
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      const jr = await fetch(`/api/job?id=${encodeURIComponent(data.jobId)}`);
      const job = await jr.json().catch(() => ({}));
      if (!jr.ok) throw new Error(job?.error || "job sumiu");
      if (job.status === "done") {
        setRefStatus("Perfil de estilo aprendido ✓ — já vale para as próximas traduções desta obra.");
        await refreshReferenceInfo();
        return;
      }
      if (job.status === "error") throw new Error(job.error || "falhou");
      setRefStatus(`Aprendendo: ${job.done}/${job.total} — ${job.current || "..."}`);
    }
  } catch (error) {
    setRefStatus(`Aprender estilo falhou: ${error.message}`);
  } finally {
    elements.learnStyle.disabled = false;
  }
}

export function initReference() {
  if (!elements.referenceUpload) return;
  elements.referenceUpload.addEventListener("click", () => elements.referenceFile?.click());
  elements.referenceFile?.addEventListener("change", () => {
    const files = [...(elements.referenceFile.files || [])];
    elements.referenceFile.value = "";
    if (files.length) uploadReferenceFiles(files).catch((e) => setRefStatus(e.message));
  });
  elements.learnStyle?.addEventListener("click", () => learnStyleNow());
  // Atualiza o painel quando a obra aberta muda (evento page-shown já existe).
  window.addEventListener("page-shown", () => {
    if (state.selectedManga !== lastManga) {
      lastManga = state.selectedManga;
      refreshReferenceInfo();
    }
  });
}
