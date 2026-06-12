// Painel "Memória & Glossário" na barra lateral: edição de glossário e
// personagens (voz) — global + por obra — e relatório de limpeza da memória
// de traduções (exemplos com tradução cortada no meio da palavra).
import { state, elements } from "./state.js";
import { api } from "./api.js";

let glossaryData = { terms: [], porObra: {} };
let charactersData = { global: {}, porObra: {} };
let lastManga = null;

function setGlossaryStatus(text) {
  if (elements.glossaryStatus) elements.glossaryStatus.textContent = text;
}
function setCharactersStatus(text) {
  if (elements.charactersStatus) elements.charactersStatus.textContent = text;
}
function setMemoryStatus(text) {
  if (elements.memoryStatus) elements.memoryStatus.textContent = text;
}

// ---------- Glossário (termos: original => tradução [+ nota]) ----------

function renderTermList(container, list, onRemove) {
  if (!container) return;
  container.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "Nenhum termo ainda.";
    container.appendChild(empty);
    return;
  }
  list.forEach((term, index) => {
    const row = document.createElement("div");
    row.className = "kv-row";

    const source = document.createElement("input");
    source.type = "text";
    source.placeholder = "original";
    source.value = term.source || "";
    source.addEventListener("input", () => { term.source = source.value; });

    const target = document.createElement("input");
    target.type = "text";
    target.placeholder = "tradução";
    target.value = term.target || "";
    target.addEventListener("input", () => { term.target = target.value; });

    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "nota (opcional)";
    note.className = "kv-note";
    note.value = term.note || "";
    note.addEventListener("input", () => { term.note = note.value; });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button tiny danger";
    remove.title = "Remover termo";
    remove.textContent = "✕";
    remove.addEventListener("click", () => onRemove(index));

    row.append(source, target, note, remove);
    container.appendChild(row);
  });
}

function renderGlossaryPanel() {
  renderTermList(elements.glossaryGlobalList, glossaryData.terms, (index) => {
    glossaryData.terms.splice(index, 1);
    renderGlossaryPanel();
  });

  const manga = state.selectedManga;
  if (elements.glossaryObraTitle) {
    elements.glossaryObraTitle.textContent = manga ? `Desta obra (${manga})` : "Desta obra";
  }
  if (elements.glossaryObraAdd) elements.glossaryObraAdd.disabled = !manga;
  const list = manga ? (glossaryData.porObra[manga] ||= []) : [];
  renderTermList(elements.glossaryObraList, list, (index) => {
    list.splice(index, 1);
    if (!list.length) delete glossaryData.porObra[manga];
    renderGlossaryPanel();
  });
}

async function loadGlossaryPanel() {
  try {
    const data = await api("/api/glossary");
    glossaryData = { terms: data.terms || [], porObra: data.porObra || {} };
    renderGlossaryPanel();
  } catch (error) {
    setGlossaryStatus(`Não consegui carregar: ${error.message}`);
  }
}

async function saveGlossaryPanel() {
  setGlossaryStatus("Salvando...");
  try {
    const data = await api("/api/glossary", {
      method: "POST",
      body: JSON.stringify(glossaryData)
    });
    glossaryData = { terms: data.terms || [], porObra: data.porObra || {} };
    renderGlossaryPanel();
    setGlossaryStatus("Glossário salvo ✓");
  } catch (error) {
    setGlossaryStatus(`Falha ao salvar: ${error.message}`);
  }
}

// ---------- Personagens (voz): nome => descrição ----------

function renderVoiceList(container, obj, onRemove) {
  if (!container) return;
  container.innerHTML = "";
  const names = Object.keys(obj);
  if (!names.length) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "Nenhum personagem ainda.";
    container.appendChild(empty);
    return;
  }
  for (const name of names) {
    const row = document.createElement("div");
    row.className = "kv-row kv-row-voice";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "personagem";
    nameInput.value = name;
    nameInput.className = "kv-name";

    const voiceInput = document.createElement("input");
    voiceInput.type = "text";
    voiceInput.placeholder = "como fala (tom, gírias, formalidade...)";
    voiceInput.value = obj[name] || "";
    voiceInput.addEventListener("input", () => { obj[name] = voiceInput.value; });

    // Renomear: troca a chave preservando a posição/valor.
    nameInput.addEventListener("change", () => {
      const newName = nameInput.value.trim();
      if (!newName || newName === name) { nameInput.value = name; return; }
      const value = obj[name];
      delete obj[name];
      obj[newName] = value;
      renderVoiceList(container, obj, onRemove);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button tiny danger";
    remove.title = "Remover personagem";
    remove.textContent = "✕";
    remove.addEventListener("click", () => onRemove(name));

    row.append(nameInput, voiceInput, remove);
    container.appendChild(row);
  }
}

function renderCharactersPanel() {
  renderVoiceList(elements.charactersGlobalList, charactersData.global, (name) => {
    delete charactersData.global[name];
    renderCharactersPanel();
  });

  const manga = state.selectedManga;
  if (elements.charactersObraTitle) {
    elements.charactersObraTitle.textContent = manga ? `Desta obra (${manga})` : "Desta obra";
  }
  if (elements.charactersObraAdd) elements.charactersObraAdd.disabled = !manga;
  const profiles = manga ? (charactersData.porObra[manga] ||= {}) : {};
  renderVoiceList(elements.charactersObraList, profiles, (name) => {
    delete profiles[name];
    if (!Object.keys(profiles).length) delete charactersData.porObra[manga];
    renderCharactersPanel();
  });
}

async function loadCharactersPanel() {
  try {
    const data = await api("/api/characters");
    charactersData = { global: data.global || {}, porObra: data.porObra || {} };
    renderCharactersPanel();
  } catch (error) {
    setCharactersStatus(`Não consegui carregar: ${error.message}`);
  }
}

async function saveCharactersPanel() {
  setCharactersStatus("Salvando...");
  try {
    const data = await api("/api/characters", {
      method: "POST",
      body: JSON.stringify(charactersData)
    });
    charactersData = { global: data.global || {}, porObra: data.porObra || {} };
    renderCharactersPanel();
    setCharactersStatus("Personagens salvos ✓");
  } catch (error) {
    setCharactersStatus(`Falha ao salvar: ${error.message}`);
  }
}

function addVoiceEntry(obj, render) {
  let name = "Novo personagem";
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(obj, name)) {
    name = `Novo personagem ${n}`;
    n += 1;
  }
  obj[name] = "";
  render();
}

// ---------- Limpeza de memória (exemplos com tradução cortada) ----------

function renderMemoryIssues(issues) {
  const container = elements.memoryIssues;
  if (!container) return;
  container.innerHTML = "";
  if (elements.memoryRemoveAll) elements.memoryRemoveAll.hidden = issues.length === 0;

  for (const issue of issues) {
    const item = document.createElement("div");
    item.className = "memory-issue";

    const meta = document.createElement("div");
    meta.className = "muted small";
    meta.textContent = `${issue.manga} · ${issue.chapter} · ${issue.page}`;

    const original = document.createElement("div");
    original.className = "memory-issue-text";
    original.textContent = `Original: ${issue.originalText}`;

    const translated = document.createElement("div");
    translated.className = "memory-issue-text memory-issue-bad";
    translated.textContent = `Tradução: ${issue.translatedText}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button tiny danger";
    remove.textContent = "Remover da memória";
    remove.addEventListener("click", () => removeMemoryIssues([issue.key]));

    item.append(meta, original, translated, remove);
    container.appendChild(item);
  }
}

async function checkMemoryIssues() {
  setMemoryStatus("Verificando...");
  if (elements.memoryIssues) elements.memoryIssues.innerHTML = "";
  if (elements.memoryRemoveAll) elements.memoryRemoveAll.hidden = true;
  try {
    const data = await api("/api/training-issues");
    if (!data.issues.length) {
      setMemoryStatus(`${data.total} exemplo(s) na memória — nenhum problema encontrado ✓`);
      return;
    }
    setMemoryStatus(`${data.issues.length} de ${data.total} exemplo(s) com tradução cortada:`);
    renderMemoryIssues(data.issues);
  } catch (error) {
    setMemoryStatus(`Falha ao verificar: ${error.message}`);
  }
}

async function removeMemoryIssues(keys) {
  setMemoryStatus("Removendo...");
  try {
    const data = await api("/api/training-issues/remove", {
      method: "POST",
      body: JSON.stringify({ keys })
    });
    await checkMemoryIssues();
    if (data.removed) setMemoryStatus(`${data.removed} exemplo(s) removido(s). ${data.remaining} restante(s).`);
  } catch (error) {
    setMemoryStatus(`Falha ao remover: ${error.message}`);
  }
}

async function removeAllMemoryIssues() {
  try {
    const data = await api("/api/training-issues");
    if (!data.issues.length) return;
    if (!window.confirm(`Remover ${data.issues.length} exemplo(s) com tradução cortada da memória?`)) return;
    await removeMemoryIssues(data.issues.map((issue) => issue.key));
  } catch (error) {
    setMemoryStatus(`Falha ao remover: ${error.message}`);
  }
}

export function initTrainingPanel() {
  elements.glossaryGlobalAdd?.addEventListener("click", () => {
    glossaryData.terms.push({ source: "", target: "", note: "" });
    renderGlossaryPanel();
  });
  elements.glossaryObraAdd?.addEventListener("click", () => {
    const manga = state.selectedManga;
    if (!manga) return;
    (glossaryData.porObra[manga] ||= []).push({ source: "", target: "", note: "" });
    renderGlossaryPanel();
  });
  elements.glossarySave?.addEventListener("click", () => saveGlossaryPanel());

  elements.charactersGlobalAdd?.addEventListener("click", () => addVoiceEntry(charactersData.global, renderCharactersPanel));
  elements.charactersObraAdd?.addEventListener("click", () => {
    const manga = state.selectedManga;
    if (!manga) return;
    addVoiceEntry((charactersData.porObra[manga] ||= {}), renderCharactersPanel);
  });
  elements.charactersSave?.addEventListener("click", () => saveCharactersPanel());

  elements.memoryCheck?.addEventListener("click", () => checkMemoryIssues());
  elements.memoryRemoveAll?.addEventListener("click", () => removeAllMemoryIssues());

  loadGlossaryPanel();
  loadCharactersPanel();

  // Quando a obra aberta muda, refaz as secoes "Desta obra".
  window.addEventListener("page-shown", () => {
    if (state.selectedManga !== lastManga) {
      lastManga = state.selectedManga;
      renderGlossaryPanel();
      renderCharactersPanel();
    }
  });
}
