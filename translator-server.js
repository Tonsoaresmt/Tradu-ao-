import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "fs-extra";
import extractZip from "extract-zip";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.TRANSLATOR_PORT || 3210);
const HOST = process.env.TRANSLATOR_HOST || "127.0.0.1";
const TRANSLATOR_ROOT_DIR = path.join(__dirname, "tradutor-manga");
const SOURCE_MANGAS_DIR = path.join(TRANSLATOR_ROOT_DIR, "entrada-originais");
const IN_PROGRESS_DIR = path.join(TRANSLATOR_ROOT_DIR, "em-traducao");
const OUTPUT_DIR = path.join(TRANSLATOR_ROOT_DIR, "traduzidos");
const PAGES_DIR = path.join(IN_PROGRESS_DIR, "paginas");
const LEGACY_MANGAS_DIR = path.join(__dirname, "..", "mangas");
const PROJECTS_DIR = path.join(IN_PROGRESS_DIR, "projetos");
const TRAINING_DIR = path.join(TRANSLATOR_ROOT_DIR, "treino");
const TRAINING_EXAMPLES_PATH = path.join(TRAINING_DIR, "exemplos.jsonl");
const TRAINING_GLOSSARY_PATH = path.join(TRAINING_DIR, "glossario.json");
const TRAINING_STYLE_PATH = path.join(TRAINING_DIR, "estilo.txt");
const PUBLIC_DIR = path.join(__dirname, "translator-ui");
const WINDOWS_OCR_SCRIPT = path.join(__dirname, "tools", "windows-ocr.ps1");
const OCR_COMMAND = process.env.TESSERACT_PATH || "tesseract";
const OCR_LANG = process.env.OCR_LANG || "eng";
const USE_OPENAI = process.env.USE_OPENAI_TRANSLATOR === "1";
const USE_OPENAI_OCR = process.env.USE_OPENAI_OCR === "1";
const OPENAI_MODEL = process.env.OPENAI_TRANSLATOR_MODEL || "gpt-4.1-mini";
const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || "";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_TRANSLATOR_MODEL || "";
// Provedor de traducao selecionavel por config (etapa plugavel): auto = cadeia completa.
const TRANSLATOR_PROVIDER = (process.env.TRANSLATOR_PROVIDER || "auto").toLowerCase();

// --- Detector de baloes (microservico Python YOLOv8-seg) ---
const DETECTOR_URL = (process.env.DETECTOR_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const DETECTOR_AUTOSTART = process.env.DETECTOR_AUTOSTART !== "0";
const DETECTOR_DIR = path.join(__dirname, "detector");
const DETECTOR_SCRIPT = path.join(DETECTOR_DIR, "service.py");
const DETECTOR_PYTHON = process.env.DETECTOR_PYTHON || path.join(
  DETECTOR_DIR,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);
const DETECTOR_OCR = process.env.DETECTOR_OCR || "tesseract"; // tesseract | manga-ocr | none
const DETECTOR_STARTUP_TIMEOUT_MS = Number(process.env.DETECTOR_STARTUP_TIMEOUT_MS || 180000);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, { "Content-Type": CONTENT_TYPES[".json"] });
  res.end(payload);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "sem-nome";
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), "pt-BR", { numeric: true, sensitivity: "base" });
}

function isImageFile(fileName) {
  return /\.(png|jpe?g|webp)$/i.test(fileName);
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function commandAvailable(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function localServerAvailable(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// === Detector de baloes (microservico Python YOLOv8-seg) ============
let detectorChild = null;
let detectorStarting = null;

async function detectorHealth(timeoutMs = 1500) {
  try {
    const response = await fetch(`${DETECTOR_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function spawnDetector() {
  const detectorUrl = new URL(DETECTOR_URL);
  detectorChild = spawn(DETECTOR_PYTHON, [DETECTOR_SCRIPT], {
    cwd: DETECTOR_DIR,
    env: {
      ...process.env,
      DETECTOR_PORT: detectorUrl.port || "5000",
      DETECTOR_HOST: detectorUrl.hostname,
      OCR_ENGINE: DETECTOR_OCR,
      OCR_LANG
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  detectorChild.on("exit", (code) => {
    console.log(`Detector encerrado (code ${code}).`);
    detectorChild = null;
  });
  detectorChild.on("error", (error) => {
    console.error(`Falha ao iniciar detector: ${error.message}`);
    detectorChild = null;
  });
}

async function ensureDetector() {
  const current = await detectorHealth();
  if (current) return current;
  if (!DETECTOR_AUTOSTART) return null;

  if (!detectorStarting) {
    detectorStarting = (async () => {
      if (!await fs.pathExists(DETECTOR_PYTHON)) {
        throw new Error(`Python do detector ausente em ${DETECTOR_PYTHON}. Instale detector/requirements.txt num venv ou defina DETECTOR_PYTHON.`);
      }
      if (!detectorChild) spawnDetector();

      const deadline = Date.now() + DETECTOR_STARTUP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const health = await detectorHealth();
        if (health) return health;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      throw new Error("Detector nao respondeu a tempo (modelo ainda baixando?). Tente novamente em instantes.");
    })().finally(() => {
      detectorStarting = null;
    });
  }

  return detectorStarting;
}

async function detectBubbles(imagePath) {
  const response = await fetch(`${DETECTOR_URL}/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imagePath, ocr: DETECTOR_OCR }),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Detector falhou: HTTP ${response.status}`);
  }

  return response.json();
}

async function renderExport(payload) {
  const response = await fetch(`${DETECTOR_URL}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(600000)
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Export falhou: HTTP ${response.status}`);
  }

  return response.json();
}

async function renderOne(payload) {
  const response = await fetch(`${DETECTOR_URL}/render-one`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Previa falhou: HTTP ${response.status}`);
  }

  return response.json();
}

function stopDetector() {
  if (detectorChild) {
    detectorChild.kill();
    detectorChild = null;
  }
}

function resolveInside(baseDir, ...segments) {
  const target = path.resolve(baseDir, ...segments);
  const relative = path.relative(baseDir, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Caminho invalido");
  }

  return target;
}

async function listLibrary() {
  const libraryDir = await getLibraryDir();
  if (!libraryDir) return [];

  const entries = await fs.readdir(libraryDir, { withFileTypes: true });
  const mangas = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const mangaDir = path.join(libraryDir, entry.name);
    const chapterEntries = await fs.readdir(mangaDir, { withFileTypes: true }).catch(() => []);
    const chapters = [];

    for (const chapterEntry of chapterEntries) {
      const chapterInfo = await inspectChapter(entry.name, chapterEntry, mangaDir);
      if (chapterInfo) chapters.push(chapterInfo);
    }

    if (!chapters.length) continue;

    mangas.push({
      name: entry.name,
      chapters: chapters.sort((a, b) => naturalCompare(a.name, b.name))
    });
  }

  return mangas.sort((a, b) => naturalCompare(a.name, b.name));
}

function buildProjectPath(manga, chapter) {
  return path.join(
    PROJECTS_DIR,
    sanitizeFileName(manga),
    `${sanitizeFileName(chapter)}.json`
  );
}

function buildPagesPath(manga, chapter) {
  return path.join(
    PAGES_DIR,
    sanitizeFileName(manga),
    sanitizeFileName(chapter)
  );
}

function buildOutputPaths(manga, chapter) {
  const mangaDir = path.join(OUTPUT_DIR, sanitizeFileName(manga));
  return {
    dir: path.join(mangaDir, sanitizeFileName(chapter)),
    cbz: path.join(mangaDir, `${sanitizeFileName(chapter)}.cbz`)
  };
}

async function loadProject(manga, chapter) {
  const projectPath = buildProjectPath(manga, chapter);

  if (!await fs.pathExists(projectPath)) {
    return {
      manga,
      chapter,
      updatedAt: null,
      pages: {}
    };
  }

  return fs.readJson(projectPath);
}

async function saveProject(project) {
  const projectPath = buildProjectPath(project.manga, project.chapter);
  await fs.ensureDir(path.dirname(projectPath));
  await fs.writeJson(projectPath, {
    ...project,
    updatedAt: new Date().toISOString()
  }, { spaces: 2 });
  const training = await recordTrainingExamples(project);

  return { projectPath, training };
}

async function ensureTranslatorDirs() {
  await Promise.all([
    fs.ensureDir(SOURCE_MANGAS_DIR),
    fs.ensureDir(IN_PROGRESS_DIR),
    fs.ensureDir(PAGES_DIR),
    fs.ensureDir(OUTPUT_DIR),
    fs.ensureDir(PROJECTS_DIR),
    fs.ensureDir(TRAINING_DIR)
  ]);

  if (!await fs.pathExists(TRAINING_STYLE_PATH)) {
    await fs.writeFile(
      TRAINING_STYLE_PATH,
      [
        "Traduza mangas para PT-BR natural.",
        "Preserve nomes proprios.",
        "Use fala curta quando o balao for pequeno.",
        "Evite explicar piadas ou contexto dentro da fala.",
        "Mantenha o tom emocional da cena."
      ].join("\n"),
      "utf8"
    );
  }

  if (!await fs.pathExists(TRAINING_GLOSSARY_PATH)) {
    await fs.writeJson(TRAINING_GLOSSARY_PATH, {
      terms: [],
      porObra: {}
    }, { spaces: 2 });
  }
}

async function getLibraryDir() {
  await ensureTranslatorDirs();

  const sourceEntries = await fs.readdir(SOURCE_MANGAS_DIR).catch(() => []);
  if (sourceEntries.length) return SOURCE_MANGAS_DIR;

  if (await fs.pathExists(LEGACY_MANGAS_DIR)) {
    const legacyEntries = await fs.readdir(LEGACY_MANGAS_DIR).catch(() => []);
    if (legacyEntries.length) return LEGACY_MANGAS_DIR;
  }

  return SOURCE_MANGAS_DIR;
}

async function collectImageFiles(rootDir) {
  async function walk(currentDir, relativePrefix = "") {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    const files = [];

    for (const entry of entries) {
      if (entry.name === "__MACOSX") continue;

      const nextRelative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        files.push(...await walk(fullPath, nextRelative));
        continue;
      }

      if (isImageFile(entry.name)) {
        files.push(nextRelative);
      }
    }

    return files;
  }

  return (await walk(rootDir)).sort(naturalCompare);
}

function isCbzFile(fileName) {
  return /\.cbz$/i.test(fileName);
}

async function inspectChapter(manga, chapterEntry, mangaDir) {
  if (chapterEntry.isDirectory()) {
    const chapterDir = path.join(mangaDir, chapterEntry.name);
    const pageFiles = await collectImageFiles(chapterDir);
    if (!pageFiles.length) return null;

    return {
      name: chapterEntry.name,
      pageCount: pageFiles.length,
      cover: `/api/page?manga=${encodeURIComponent(manga)}&chapter=${encodeURIComponent(chapterEntry.name)}&file=${encodeURIComponent(pageFiles[0])}`,
      status: "ready",
      sourceType: "folder"
    };
  }

  if (!isCbzFile(chapterEntry.name)) {
    return null;
  }

  const chapterName = chapterEntry.name.replace(/\.cbz$/i, "");
  const extractedDir = buildPagesPath(manga, chapterName);
  const pageFiles = await collectImageFiles(extractedDir);
  const ready = pageFiles.length > 0;

  return {
    name: chapterName,
    pageCount: ready ? pageFiles.length : null,
    cover: ready
      ? `/api/page?manga=${encodeURIComponent(manga)}&chapter=${encodeURIComponent(chapterName)}&file=${encodeURIComponent(pageFiles[0])}`
      : null,
    status: ready ? "ready" : "pending_extract",
    sourceType: "cbz"
  };
}

async function ensureChapterReady(manga, chapter) {
  const libraryDir = await getLibraryDir();
  const sourceChapterDir = resolveInside(libraryDir, manga, chapter);
  const sourceDirStat = await fs.stat(sourceChapterDir).catch(() => null);

  if (sourceDirStat?.isDirectory()) {
    return {
      chapterDir: sourceChapterDir,
      sourceType: "folder"
    };
  }

  const archivePath = resolveInside(libraryDir, manga, `${chapter}.cbz`);
  const archiveStat = await fs.stat(archivePath).catch(() => null);
  if (!archiveStat?.isFile()) {
    throw new Error("Capitulo nao encontrado");
  }

  const extractedDir = buildPagesPath(manga, chapter);
  const existingPages = await collectImageFiles(extractedDir);

  if (!existingPages.length) {
    await fs.remove(extractedDir).catch(() => {});
    await fs.ensureDir(extractedDir);
    await extractZip(archivePath, { dir: extractedDir });
  }

  return {
    chapterDir: extractedDir,
    sourceType: "cbz"
  };
}

async function getChapterPayload(manga, chapter) {
  const { chapterDir, sourceType } = await ensureChapterReady(manga, chapter);
  const pageFiles = await collectImageFiles(chapterDir);

  if (!pageFiles.length) {
    throw new Error("Nenhuma pagina encontrada");
  }

  return {
    manga,
    chapter,
    pages: pageFiles.map((fileName, index) => ({
      index,
      name: fileName,
      url: `/api/page?manga=${encodeURIComponent(manga)}&chapter=${encodeURIComponent(chapter)}&file=${encodeURIComponent(fileName)}`
    })),
    sourceType,
    project: await loadProject(manga, chapter)
  };
}

function cleanOcrText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[|}{[\]]/g, "")
    .trim();
}

function parseTesseractTsv(tsv) {
  const rows = String(tsv || "").trim().split(/\r?\n/);
  const headers = rows.shift()?.split("\t") || [];
  const byLine = new Map();
  let pageWidth = 0;
  let pageHeight = 0;

  for (const row of rows) {
    const cells = row.split("\t");
    const item = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    const level = Number(item.level);
    const width = Number(item.width);
    const height = Number(item.height);

    if (level === 1) {
      pageWidth = width || pageWidth;
      pageHeight = height || pageHeight;
      continue;
    }

    if (level !== 5) continue;

    const text = cleanOcrText(item.text);
    const confidence = Number(item.conf);
    if (!text || confidence < 25) continue;

    const key = [
      item.block_num,
      item.par_num,
      item.line_num
    ].join(":");
    const current = byLine.get(key) || {
      words: [],
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: 0,
      bottom: 0,
      confidenceTotal: 0,
      confidenceCount: 0
    };

    const left = Number(item.left);
    const top = Number(item.top);
    current.words.push(text);
    current.left = Math.min(current.left, left);
    current.top = Math.min(current.top, top);
    current.right = Math.max(current.right, left + width);
    current.bottom = Math.max(current.bottom, top + height);
    current.confidenceTotal += confidence;
    current.confidenceCount += 1;
    byLine.set(key, current);
  }

  return [...byLine.values()]
    .map((line) => ({
      originalText: cleanOcrText(line.words.join(" ")),
      confidence: Math.round(line.confidenceTotal / Math.max(1, line.confidenceCount)),
      x: pageWidth ? line.left / pageWidth : 0.08,
      y: pageHeight ? line.top / pageHeight : 0.08,
      width: pageWidth ? Math.max(0.08, (line.right - line.left) / pageWidth) : 0.28,
      height: pageHeight ? Math.max(0.05, (line.bottom - line.top) / pageHeight) : 0.1
    }))
    .filter((line) => line.originalText)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function imageMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function friendlyProviderError(message) {
  const value = String(message || "");

  if (value.includes("HTTP 401")) {
    return "Chave OpenAI invalida ou sem permissao. Ajuste OPENAI_API_KEY ou use OCR local com Tesseract.";
  }

  if (value.includes("HTTP 429")) {
    return "Limite da OpenAI atingido. Tente novamente mais tarde ou use OCR local com Tesseract.";
  }

  if (value.includes("HTTP 400")) {
    return "A OpenAI recusou a imagem ou o pedido. Tente outra pagina ou use OCR local com Tesseract.";
  }

  return value || "Provedor automatico indisponivel.";
}

async function ocrWithOpenAi(imagePath) {
  if (!USE_OPENAI_OCR || !process.env.OPENAI_API_KEY) return null;

  const imageBytes = await fs.readFile(imagePath);
  const imageUrl = `data:${imageMimeType(imagePath)};base64,${imageBytes.toString("base64")}`;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: "Detecte textos visiveis em paginas de manga/quadrinhos. Retorne apenas JSON valido no formato {\"lines\":[{\"originalText\":\"...\",\"x\":0.1,\"y\":0.2,\"width\":0.3,\"height\":0.1,\"confidence\":80}]}. Use coordenadas normalizadas de 0 a 1 relativas a imagem inteira, em ordem de leitura."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Liste todos os textos legiveis desta pagina com caixas aproximadas."
            },
            {
              type: "input_image",
              image_url: imageUrl
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI OCR falhou: HTTP ${response.status}`);
  }

  const data = await response.json();
  const parsed = parseJsonFromText(data.output_text);
  const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];

  return lines
    .map((line) => ({
      originalText: cleanOcrText(line.originalText),
      confidence: Number(line.confidence) || 70,
      x: clampNumber(line.x, 0, 0.95, 0.08),
      y: clampNumber(line.y, 0, 0.95, 0.08),
      width: clampNumber(line.width, 0.05, 1, 0.28),
      height: clampNumber(line.height, 0.04, 1, 0.1)
    }))
    .filter((line) => line.originalText)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

async function ocrWithWindows(imagePath) {
  if (process.platform !== "win32" || !await fs.pathExists(WINDOWS_OCR_SCRIPT)) {
    return null;
  }

  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_OCR_SCRIPT,
      "-ImagePath",
      imagePath
    ],
    {
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    }
  );

  const parsed = JSON.parse(stdout);
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];

  return lines
    .map((line) => ({
      originalText: cleanOcrText(line.originalText),
      confidence: Number(line.confidence) || 70,
      x: clampNumber(line.x, 0, 0.95, 0.08),
      y: clampNumber(line.y, 0, 0.95, 0.08),
      width: clampNumber(line.width, 0.05, 1, 0.28),
      height: clampNumber(line.height, 0.04, 1, 0.1),
      words: Array.isArray(line.words) ? line.words : []
    }))
    .filter((line) => line.originalText)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function localSuggestion(text) {
  const value = cleanOcrText(text);
  if (!value) return "";

  const common = new Map([
    ["yes", "sim"],
    ["no", "nao"],
    ["thanks", "obrigado"],
    ["thank you", "obrigado"],
    ["sorry", "desculpa"],
    ["what", "o que"],
    ["why", "por que"],
    ["who", "quem"],
    ["where", "onde"],
    ["wait", "espera"],
    ["stop", "para"],
    ["help", "ajuda"],
    ["hello", "ola"],
    ["hey", "ei"],
    ["damn", "droga"],
    ["shit", "merda"],
    ["i don't know", "eu nao sei"],
    ["i do not know", "eu nao sei"],
    ["are you okay", "voce esta bem"],
    ["it's okay", "tudo bem"]
  ]);

  const key = value.toLowerCase().replace(/[!?.,]+$/g, "");
  return common.get(key) || value;
}

function memoryKey(text) {
  return cleanOcrText(text).toLowerCase();
}

// Chave "fuzzy": so letras/numeros — casa apesar de pontuacao/ruido do OCR.
function alnumKey(text) {
  return cleanOcrText(text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function exampleKey(example) {
  return [
    memoryKey(example.manga),
    memoryKey(example.originalText)
  ].join("::");
}

async function loadTrainingExamples() {
  if (!await fs.pathExists(TRAINING_EXAMPLES_PATH)) return [];

  const raw = await fs.readFile(TRAINING_EXAMPLES_PATH, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function saveTrainingExamples(examples) {
  await fs.ensureDir(TRAINING_DIR);
  const payload = examples
    .map((example) => JSON.stringify(example))
    .join("\n");
  await fs.writeFile(TRAINING_EXAMPLES_PATH, payload ? `${payload}\n` : "", "utf8");
}

async function recordTrainingExamples(project) {
  const existing = await loadTrainingExamples();
  const byKey = new Map(existing.map((example) => [exampleKey(example), example]));
  let addedOrUpdated = 0;

  for (const [pageName, page] of Object.entries(project.pages || {})) {
    const boxes = Array.isArray(page?.boxes) ? page.boxes : [];
    const pageContext = boxes
      .map((box) => cleanOcrText(box.originalText))
      .filter(Boolean);

    for (const box of boxes) {
      const originalText = cleanOcrText(box.originalText);
      const translatedText = cleanOcrText(box.translatedText);
      if (!originalText || !translatedText) continue;

      // Gate de qualidade (ideia do quality_score do onyx): "human" quando o
      // revisor escreveu/alterou a fala; "auto" quando so aceitou a sugestao.
      const suggestedText = cleanOcrText(box.suggestedText);
      const quality = (!suggestedText || suggestedText.toLowerCase() !== translatedText.toLowerCase())
        ? "human"
        : "auto";

      const example = {
        manga: project.manga,
        chapter: project.chapter,
        page: pageName,
        originalText,
        translatedText,
        quality,
        context: pageContext,
        box: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height
        },
        updatedAt: new Date().toISOString()
      };

      byKey.set(exampleKey(example), example);
      addedOrUpdated++;
    }
  }

  await saveTrainingExamples([...byKey.values()]);
  return {
    examples: byKey.size,
    updated: addedOrUpdated,
    path: TRAINING_EXAMPLES_PATH
  };
}

async function loadTrainingStyle() {
  return fs.readFile(TRAINING_STYLE_PATH, "utf8").catch(() => "");
}

async function loadGlossaryRaw() {
  const glossary = await fs.readJson(TRAINING_GLOSSARY_PATH).catch(() => ({ terms: [] }));
  return {
    terms: Array.isArray(glossary.terms) ? glossary.terms : [],
    porObra: glossary.porObra && typeof glossary.porObra === "object" ? glossary.porObra : {}
  };
}

async function loadTrainingGlossary() {
  return (await loadGlossaryRaw()).terms;
}

// Termos globais + os especificos da obra atual (glossario por obra).
async function glossaryForManga(manga) {
  const { terms, porObra } = await loadGlossaryRaw();
  const own = [];
  for (const [key, list] of Object.entries(porObra)) {
    if (memoryKey(key) === memoryKey(manga) && Array.isArray(list)) {
      own.push(...list);
    }
  }
  return [...terms, ...own];
}

function scoreExample(example, text, context = {}) {
  const words = new Set(memoryKey(text).split(/\s+/).filter((word) => word.length > 2));
  const exampleWords = new Set(memoryKey(example.originalText).split(/\s+/).filter((word) => word.length > 2));
  let score = 0;

  for (const word of words) {
    if (exampleWords.has(word)) score += 2;
  }

  if (memoryKey(context.manga) && memoryKey(context.manga) === memoryKey(example.manga)) score += 3;
  if (memoryKey(context.chapter) && memoryKey(context.chapter) === memoryKey(example.chapter)) score += 1;
  if (example.quality === "human" || example.quality === undefined) score += 1;
  return score;
}

async function findRelevantTrainingExamples(text, context = {}, limit = 6) {
  const examples = await loadTrainingExamples();
  return examples
    .map((example) => ({
      example,
      score: scoreExample(example, text, context)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.example);
}

// Indice em memoria construido a partir do exemplos.jsonl (que ja agrega todas as
// falas salvas). Reconstroi so quando o arquivo muda (mtime) — sem varrer JSONs.
let memoryIndexCache = { mtime: -1, byExact: new Map(), byAlnum: new Map() };

async function getMemoryIndex() {
  const stat = await fs.stat(TRAINING_EXAMPLES_PATH).catch(() => null);
  const mtime = stat ? stat.mtimeMs : 0;
  if (mtime === memoryIndexCache.mtime) return memoryIndexCache;

  const byExact = new Map();
  const byAlnum = new Map();

  for (const example of await loadTrainingExamples()) {
    const translatedText = cleanOcrText(example.translatedText);
    if (!translatedText) continue;
    // Gate: so reusa traducao vetada por humano (quality_score do onyx).
    // Exemplos antigos (sem o campo) sao tratados como confiaveis.
    if (example.quality && example.quality !== "human") continue;

    const exact = memoryKey(example.originalText);
    if (exact && !byExact.has(exact)) byExact.set(exact, translatedText);
    const alnum = alnumKey(example.originalText);
    if (alnum && !byAlnum.has(alnum)) byAlnum.set(alnum, translatedText);
  }

  memoryIndexCache = { mtime, byExact, byAlnum };
  return memoryIndexCache;
}

async function findTranslationMemory(text) {
  const key = memoryKey(text);
  if (!key) return null;

  const index = await getMemoryIndex();
  if (index.byExact.has(key)) return index.byExact.get(key);

  // Fuzzy leve: ignora pontuacao/ruido do OCR (REUBEN? casa com REUBEN).
  const alnum = alnumKey(text);
  if (alnum && index.byAlnum.has(alnum)) return index.byAlnum.get(alnum);

  return null;
}

async function translateWithLibreTranslate(text) {
  if (!LIBRETRANSLATE_URL) return null;

  const response = await fetch(LIBRETRANSLATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      source: "auto",
      target: "pt",
      format: "text"
    })
  });

  if (!response.ok) {
    throw new Error(`LibreTranslate falhou: HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    provider: "libretranslate",
    text: data.translatedText || ""
  };
}

async function translateWithOpenAi(text) {
  if (!USE_OPENAI || !process.env.OPENAI_API_KEY) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: "Traduza falas de manga para portugues brasileiro natural. Preserve nomes proprios, onomatopeias importantes e sentido emocional. Responda apenas com a traducao."
        },
        {
          role: "user",
          content: text
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI falhou: HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    provider: "openai",
    text: data.output_text || ""
  };
}

async function getOllamaModel() {
  if (OLLAMA_MODEL) return OLLAMA_MODEL;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return "";

    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    return models[0]?.name || "";
  } catch {
    return "";
  }
}

async function translateWithOllama(text, context = {}) {
  const model = await getOllamaModel();
  if (!model) return null;

  const style = await loadTrainingStyle();
  const glossary = await glossaryForManga(context.manga);
  const examples = await findRelevantTrainingExamples(text, context);
  const nearby = Array.isArray(context.nearbyLines)
    ? context.nearbyLines.filter(Boolean).join("\n")
    : "";
  const glossaryText = glossary
    .filter((item) => item?.source && item?.target)
    .map((item) => `${item.source} => ${item.target}${item.note ? ` (${item.note})` : ""}`)
    .join("\n");
  const examplesText = examples
    .map((example) => `EN: ${example.originalText}\nPT-BR: ${example.translatedText}`)
    .join("\n\n");
  const prompt = [
    "Traduza a fala de manga abaixo para portugues brasileiro natural.",
    "Use o contexto da cena quando existir.",
    "Preserve nomes proprios e nao explique nada.",
    style ? `Estilo desejado:\n${style}` : "",
    glossaryText ? `Glossario fixo:\n${glossaryText}` : "",
    examplesText ? `Exemplos aprovados pelo revisor:\n${examplesText}` : "",
    nearby ? `Contexto da pagina:\n${nearby}` : "",
    `Fala em ingles:\n${text}`,
    "Traducao PT-BR:"
  ].filter(Boolean).join("\n\n");

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama falhou: HTTP ${response.status}`);
  }

  const data = await response.json();
  return {
    provider: `ollama:${model}`,
    text: cleanOcrText(data.response || "")
  };
}

// Registry de provedores de traducao (etapas plugaveis, trocaveis por config).
const TRANSLATION_BACKENDS = {
  ollama: (value, context) => translateWithOllama(value, context),
  openai: (value) => translateWithOpenAi(value),
  libre: (value) => translateWithLibreTranslate(value),
  libretranslate: (value) => translateWithLibreTranslate(value)
};

async function suggestTranslation(text, context = {}) {
  const value = cleanOcrText(text);
  if (!value) {
    return {
      provider: "empty",
      text: "",
      automatic: false
    };
  }

  // Memoria (vetada por humano) sempre primeiro.
  const memory = await findTranslationMemory(value);
  if (memory) {
    return {
      provider: "memoria",
      text: memory,
      automatic: false,
      note: "Sugestao baseada em uma correcao salva anteriormente."
    };
  }

  const chain = TRANSLATOR_PROVIDER === "auto"
    ? ["ollama", "openai", "libre"]
    : [TRANSLATOR_PROVIDER].filter((name) => TRANSLATION_BACKENDS[name]);

  const providerErrors = [];
  for (const name of chain) {
    try {
      const result = await TRANSLATION_BACKENDS[name](value, context);
      if (result?.text) {
        return { ...result, automatic: true };
      }
    } catch (error) {
      providerErrors.push(friendlyProviderError(error.message));
    }
  }

  return {
    provider: "local-basic",
    text: localSuggestion(value),
    automatic: false,
    note: providerErrors.length
      ? `Provedor automatico indisponivel: ${providerErrors.join(" | ")}`
      : "Sugestao basica local. Para contexto melhor, rode uma IA local via Ollama ou salve correcoes para alimentar a memoria."
  };
}

// === Fila de pre-processamento por capitulo =========================
// Roda detect + OCR + sugestao em TODAS as paginas como job em background;
// salva o projeto pre-preenchido pro humano so revisar. Nao sobrescreve
// paginas que ja tem caixas (trabalho humano).
const jobs = new Map();

function newBoxId() {
  return `box-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function createJob(type, meta) {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  const job = {
    id,
    type,
    ...meta,
    status: "running",
    total: 0,
    done: 0,
    current: null,
    detectedBoxes: 0,
    suggested: 0,
    skipped: 0,
    error: null,
    startedAt: new Date().toISOString()
  };
  jobs.set(id, job);
  if (jobs.size > 20) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

async function preprocessChapter(job, { suggest }) {
  try {
    const payload = await getChapterPayload(job.manga, job.chapter);
    const { chapterDir } = await ensureChapterReady(job.manga, job.chapter);
    const project = await loadProject(job.manga, job.chapter);
    project.manga = job.manga;
    project.chapter = job.chapter;
    project.pages = project.pages || {};
    job.total = payload.pages.length;

    const health = await ensureDetector();
    if (!health || !health.yolo) {
      throw new Error("Detector de baloes indisponivel para pre-processar.");
    }

    for (const page of payload.pages) {
      job.current = page.name;

      const existing = project.pages[page.name]?.boxes;
      if (existing && existing.length) {
        job.skipped++;
        job.done++;
        continue;
      }

      const imagePath = path.join(chapterDir, page.name);
      let lines = [];
      try {
        const result = await detectBubbles(imagePath);
        lines = Array.isArray(result.lines) ? result.lines : [];
      } catch {
        // pagina sem deteccao segue em branco
      }

      const boxes = lines.map((line, index) => ({
        id: newBoxId(),
        order: index + 1,
        originalText: line.originalText || "",
        suggestedText: "",
        translatedText: "",
        coverOriginal: true,
        fontSize: 18,
        x: line.x,
        y: line.y,
        width: line.width,
        height: line.height
      }));
      job.detectedBoxes += boxes.length;

      if (suggest) {
        const nearby = boxes.map((box) => box.originalText).filter(Boolean);
        for (const box of boxes) {
          if (!box.originalText) continue;
          try {
            const result = await suggestTranslation(box.originalText, {
              manga: job.manga,
              chapter: job.chapter,
              page: page.name,
              nearbyLines: nearby
            });
            if (result?.text) {
              box.suggestedText = result.text;
              job.suggested++;
            }
          } catch {
            // sugestao e best-effort
          }
        }
      }

      project.pages[page.name] = { boxes };
      job.done++;
    }

    await saveProject(project);
    job.status = "done";
    job.finishedAt = new Date().toISOString();
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
  }
}

async function getPageImagePath(manga, chapter, fileName) {
  const { chapterDir } = await ensureChapterReady(manga, chapter);
  return resolveInside(chapterDir, fileName);
}

async function serveFile(res, absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  const exists = await fs.pathExists(absolutePath);

  if (!exists) {
    sendError(res, 404, "Arquivo nao encontrado");
    return;
  }

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(absolutePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/library") {
      const libraryDir = await getLibraryDir();
      const ocrAvailable = await commandAvailable(OCR_COMMAND);
      const windowsOcrAvailable = process.platform === "win32" && await fs.pathExists(WINDOWS_OCR_SCRIPT);
      const ollamaAvailable = await localServerAvailable(`${OLLAMA_URL}/api/tags`);
      const detector = await detectorHealth();
      const detectorPythonReady = await fs.pathExists(DETECTOR_PYTHON);
      sendJson(res, 200, {
        mangas: await listLibrary(),
        tools: {
          bubbleDetector: {
            running: Boolean(detector),
            yolo: detector?.yolo || false,
            ocrEngine: detector?.ocrEngine || DETECTOR_OCR,
            ocrReady: detector?.ocrReady || false,
            pythonReady: detectorPythonReady,
            url: DETECTOR_URL
          },
          ocr: {
            available: ocrAvailable,
            command: OCR_COMMAND,
            language: OCR_LANG,
            providers: {
              tesseract: ocrAvailable,
              windows: windowsOcrAvailable,
              openaiConfigured: USE_OPENAI_OCR && Boolean(process.env.OPENAI_API_KEY)
            }
          },
          translation: {
            provider: ollamaAvailable
              ? "ollama"
              : USE_OPENAI && process.env.OPENAI_API_KEY
              ? "openai"
              : LIBRETRANSLATE_URL
                ? "libretranslate"
                : "local-basic",
            ollamaAvailable
          }
        },
        folders: {
          source: SOURCE_MANGAS_DIR,
          inProgress: IN_PROGRESS_DIR,
          pages: PAGES_DIR,
          projects: PROJECTS_DIR,
          output: OUTPUT_DIR,
          activeLibrary: libraryDir
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/chapter") {
      const manga = url.searchParams.get("manga") || "";
      const chapter = url.searchParams.get("chapter") || "";
      sendJson(res, 200, await getChapterPayload(manga, chapter));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/training") {
      const examples = await loadTrainingExamples();
      const glossaryRaw = await loadGlossaryRaw();
      const humanExamples = examples.filter((ex) => !ex.quality || ex.quality === "human").length;
      const glossaryPorObra = Object.fromEntries(
        Object.entries(glossaryRaw.porObra).map(([obra, list]) => [obra, Array.isArray(list) ? list.length : 0])
      );
      sendJson(res, 200, {
        examples: examples.length,
        humanExamples,
        autoExamples: examples.length - humanExamples,
        glossaryTerms: glossaryRaw.terms.length,
        glossaryPorObra,
        paths: {
          directory: TRAINING_DIR,
          examples: TRAINING_EXAMPLES_PATH,
          glossary: TRAINING_GLOSSARY_PATH,
          style: TRAINING_STYLE_PATH
        },
        ollama: {
          available: await localServerAvailable(`${OLLAMA_URL}/api/tags`),
          url: OLLAMA_URL,
          model: await getOllamaModel()
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/page") {
      const manga = url.searchParams.get("manga") || "";
      const chapter = url.searchParams.get("chapter") || "";
      const fileName = url.searchParams.get("file") || "";
      const absolutePath = await getPageImagePath(manga, chapter, fileName);
      await serveFile(res, absolutePath);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr-page") {
      const body = await readJsonBody(req);
      const manga = String(body.manga || "").trim();
      const chapter = String(body.chapter || "").trim();
      const fileName = String(body.page || "").trim();

      const imagePath = await getPageImagePath(manga, chapter, fileName);

      // 1) Detector de baloes (YOLO): cada caixa ja nasce posicionada no balao.
      try {
        const health = await ensureDetector();
        if (health && health.yolo) {
          const result = await detectBubbles(imagePath);
          const lines = Array.isArray(result.lines) ? result.lines : [];
          sendJson(res, 200, {
            ok: true,
            available: true,
            provider: result.provider || "yolo",
            positioned: true,
            lines,
            message: health.ocrReady
              ? `${lines.length} balao(oes) detectado(s) e lido(s) por ${result.provider || "yolo"}.`
              : `${lines.length} balao(oes) posicionado(s). OCR de texto indisponivel (${health.ocrError ? health.ocrEngine + ": " + health.ocrError : "instale Tesseract ou use manga-ocr"}); preencha o texto na revisao.`
          });
          return;
        }
      } catch (error) {
        console.error(`Detector indisponivel, usando OCR plano: ${error.message}`);
      }

      const tesseractAvailable = await commandAvailable(OCR_COMMAND);

      if (tesseractAvailable) {
        const { stdout } = await execFileAsync(OCR_COMMAND, [imagePath, "stdout", "-l", OCR_LANG, "tsv"], {
          timeout: 120000,
          maxBuffer: 20 * 1024 * 1024
        });

        sendJson(res, 200, {
          ok: true,
          available: true,
          provider: "tesseract",
          language: OCR_LANG,
          lines: parseTesseractTsv(stdout)
        });
        return;
      }

      try {
        const lines = await ocrWithWindows(imagePath);
        if (lines) {
          sendJson(res, 200, {
            ok: true,
            available: true,
            provider: "windows-ocr",
            lines
          });
          return;
        }
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          available: false,
          lines: [],
          message: `Windows OCR falhou: ${error.message}`
        });
        return;
      }

      try {
        const lines = await ocrWithOpenAi(imagePath);
        if (lines) {
          sendJson(res, 200, {
            ok: true,
            available: true,
            provider: "openai",
            lines
          });
          return;
        }
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          available: false,
          lines: [],
          message: friendlyProviderError(error.message)
        });
        return;
      }

      sendJson(res, 200, {
        ok: false,
        available: false,
        lines: [],
        message: "OCR indisponivel. Instale Tesseract ou use o OCR local do Windows."
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/suggest-translation") {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const context = body.context && typeof body.context === "object" ? body.context : {};
      const suggestions = [];

      for (const item of items) {
        const id = String(item.id || "");
        const originalText = String(item.originalText || "");
        suggestions.push({
          id,
          originalText,
          ...await suggestTranslation(originalText, context)
        });
      }

      sendJson(res, 200, { suggestions });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/export") {
      const body = await readJsonBody(req);
      const manga = String(body.manga || "").trim();
      const chapter = String(body.chapter || "").trim();
      const format = body.format === "png" ? "png" : "cbz";

      if (!manga || !chapter) {
        sendError(res, 400, "Manga e capitulo sao obrigatorios");
        return;
      }

      const health = await ensureDetector().catch(() => null);
      if (!health) {
        sendError(res, 503, "Renderizador indisponivel. Verifique o ambiente Python em detector/.");
        return;
      }

      const payloadChapter = await getChapterPayload(manga, chapter);
      const project = await loadProject(manga, chapter);
      const { chapterDir } = await ensureChapterReady(manga, chapter);
      const { dir, cbz } = buildOutputPaths(manga, chapter);
      await fs.ensureDir(dir);

      const pages = payloadChapter.pages.map((page, index) => ({
        imagePath: path.join(chapterDir, page.name),
        outName: `${String(index + 1).padStart(3, "0")}.png`,
        boxes: (project.pages?.[page.name]?.boxes || [])
          .filter((box) => String(box.translatedText || "").trim())
      }));

      const translatedCount = pages.reduce((sum, page) => sum + page.boxes.length, 0);
      if (!translatedCount) {
        sendError(res, 400, "Nenhuma fala traduzida para exportar. Preencha a traducao final antes.");
        return;
      }

      const result = await renderExport({
        pages,
        outputDir: dir,
        cbzPath: format === "cbz" ? cbz : null,
        font: process.env.RENDER_FONT || undefined
      });

      sendJson(res, 200, {
        ok: true,
        outputDir: result.outputDir || dir,
        cbz: result.cbz,
        pages: result.pages,
        boxesRendered: result.boxesRendered,
        font: result.font
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/preview-page") {
      const body = await readJsonBody(req);
      const manga = String(body.manga || "").trim();
      const chapter = String(body.chapter || "").trim();
      const page = String(body.page || "").trim();
      const boxes = Array.isArray(body.boxes) ? body.boxes : [];

      if (!manga || !chapter || !page) {
        sendError(res, 400, "Manga, capitulo e pagina sao obrigatorios");
        return;
      }

      const health = await ensureDetector().catch(() => null);
      if (!health) {
        sendError(res, 503, "Renderizador indisponivel. Verifique o ambiente Python em detector/.");
        return;
      }

      const imagePath = await getPageImagePath(manga, chapter, page);
      const result = await renderOne({
        imagePath,
        boxes,
        font: process.env.RENDER_FONT || undefined
      });
      sendJson(res, 200, {
        ok: true,
        dataUrl: result.dataUrl,
        boxesRendered: result.boxesRendered
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/preprocess-chapter") {
      const body = await readJsonBody(req);
      const manga = String(body.manga || "").trim();
      const chapter = String(body.chapter || "").trim();
      const suggest = body.suggest !== false;

      if (!manga || !chapter) {
        sendError(res, 400, "Manga e capitulo sao obrigatorios");
        return;
      }

      const job = createJob("preprocess", { manga, chapter, suggest });
      preprocessChapter(job, { suggest }); // roda em background, nao aguarda
      sendJson(res, 200, { ok: true, jobId: job.id });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/job") {
      const id = url.searchParams.get("id") || "";
      const job = jobs.get(id);
      if (!job) {
        sendError(res, 404, "Job nao encontrado");
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/project") {
      const body = await readJsonBody(req);
      const manga = String(body.manga || "").trim();
      const chapter = String(body.chapter || "").trim();
      const pages = body.pages && typeof body.pages === "object" ? body.pages : {};

      if (!manga || !chapter) {
        sendError(res, 400, "Manga e capitulo sao obrigatorios");
        return;
      }

      await getChapterPayload(manga, chapter);
      const saved = await saveProject({ manga, chapter, pages });
      sendJson(res, 200, {
        ok: true,
        savedPath: saved.projectPath,
        training: saved.training
      });
      return;
    }

    const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const absolutePath = resolveInside(PUBLIC_DIR, safePath.slice(1));
    await serveFile(res, absolutePath);
  } catch (error) {
    const message = error instanceof SyntaxError
      ? "JSON invalido"
      : error instanceof Error
        ? error.message
        : "Erro interno";

    sendError(res, 500, message);
  }
});

ensureTranslatorDirs()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Tradutor de manga em http://${HOST}:${PORT}`);
      console.log(`Entrada de mangas: ${SOURCE_MANGAS_DIR}`);
      console.log(`Paginas preparadas: ${PAGES_DIR}`);
      console.log(`Projetos em traducao: ${PROJECTS_DIR}`);
      console.log(`Saida traduzida: ${OUTPUT_DIR}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao preparar pastas do tradutor:", error.message);
    process.exit(1);
  });

// Encerra o detector junto com o servidor.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopDetector();
    process.exit(0);
  });
}
process.on("exit", stopDetector);
