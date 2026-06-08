# Tradutor de Mangá (human-in-the-loop)

Subprojeto separado do `manga-downloader`. O diferencial é a **revisão humana**: a
máquina sugere, o humano confere, edita e aprova cada fala antes de sair.

> Pasta isolada (gitignored, igual ao `Meruem/`). Roda sozinha, mas continua podendo
> puxar capítulos da biblioteca de download (ver "Ponte com o downloader").

## Como rodar

```bash
cd tradutor
npm install          # só na primeira vez (ou se mover a pasta pra fora do repo)
npm start            # sobe em http://127.0.0.1:3210
```

Enquanto a pasta estiver dentro do `manga-downloader`, o Node já encontra as
dependências (`fs-extra`, `extract-zip`) no `node_modules` do projeto pai, então
`npm start` funciona mesmo sem `npm install`.

## Estrutura

```
tradutor/
├── translator-server.js   Backend (HTTP puro, porta 3210)
├── translator-ui/         SPA de revisão (app.js / index.html / styles.css)
├── tradutor-manga/        Dados
│   ├── entrada-originais/  mangás de origem (.cbz ou pastas de imagens)
│   ├── em-traducao/        páginas extraídas + projetos (.json por capítulo)
│   ├── traduzidos/         saída final (export ainda não implementado — ver roadmap)
│   └── treino/             memória: exemplos.jsonl, glossario.json, estilo.txt
└── tools/windows-ocr.ps1  OCR via API nativa do Windows
```

## Ponte com o downloader

`translator-server.js` usa `entrada-originais/` como biblioteca principal e, se estiver
vazia, cai de volta para `../mangas` (a biblioteca do `manga-downloader`). Assim dá pra
baixar um capítulo e traduzir na sequência sem copiar arquivos.

## Variáveis de ambiente

| Var | Default | Uso |
|---|---|---|
| `TRANSLATOR_PORT` / `TRANSLATOR_HOST` | 3210 / 127.0.0.1 | endereço do servidor |
| `OCR_LANG` | `eng` | idioma do Tesseract |
| `TESSERACT_PATH` | `tesseract` | binário do Tesseract |
| `OLLAMA_URL` / `OLLAMA_TRANSLATOR_MODEL` | localhost:11434 | tradução local |
| `USE_OPENAI_TRANSLATOR` / `USE_OPENAI_OCR` / `OPENAI_API_KEY` | — | provedores OpenAI |
| `LIBRETRANSLATE_URL` | — | tradução via LibreTranslate |
| `DETECTOR_URL` | http://127.0.0.1:5000 | endereço do microserviço de balões |
| `DETECTOR_AUTOSTART` | `1` | `0` desliga o auto-spawn do detector pelo Node |
| `DETECTOR_PYTHON` | `detector/.venv/...python` | python do venv do detector |
| `DETECTOR_OCR` | `tesseract` | engine de OCR do detector: `tesseract` / `manga-ocr` / `none` |
| `RENDER_FONT` | Arial Bold | fonte (.ttf) usada no typeset do capítulo exportado |
| `TRANSLATOR_PROVIDER` | `auto` | provedor de tradução: `auto` (cadeia) / `ollama` / `openai` / `libre` |

## Detector de balões (Fase 1 — YOLOv8-seg)

Cada caixa **nasce posicionada no balão** (resolve o "colocar no lugar exato"). É um
microserviço Python (`detector/service.py`) que o `translator-server.js` chama; se ele
não estiver de pé, o Node **auto-sobe** ele (ou cai no OCR antigo se faltar o ambiente).

Setup (uma vez):

```bash
cd tradutor/detector
python -m venv .venv
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python -m pip install -r requirements.txt
```

Na primeira detecção, o modelo de balões (`kitsumed/yolov8m_seg-speech-bubble`) é baixado
automaticamente do HuggingFace (~50 MB). Depois é rápido.

**OCR do texto dentro do balão** — selecionável **na interface** (dropdown na barra de
falas), por requisição, sem reiniciar nada:
- **EN · Tesseract**: inglês → PT-BR (precisa do [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki) instalado).
- **JP · MangaOCR**: raws japonesas (`kha-white/manga-ocr-base`, referência p/ mangá; baixa
  o modelo ~400 MB na 1ª vez, depois fica em cache; ambos os engines convivem em memória).
- **Só posicionar**: caixas vêm posicionadas e vazias; você preenche o texto na revisão.

O servidor envia o engine escolhido ao detector (`/detect {ocr}`); `DETECTOR_OCR` define só
o padrão. Cada engine é carregado sob demanda e cacheado.

**GPU NVIDIA** (mais rápido): troque o torch CPU por
`pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121`.

## Roadmap (do mais barato pro mais ambicioso)

- **Fase 1 — Detecção de balões + OCR** ✅ *implementado*: YOLOv8-seg
  (`kitsumed/yolov8m_seg-speech-bubble`) posiciona cada caixa no balão via o microserviço
  `detector/`. OCR opcional (Tesseract p/ inglês, manga-ocr p/ japonês).
- **Fase 2 — Inpainting + export** ✅ *implementado*: botão **"Gerar capítulo"** →
  `cv2.inpaint` (Otsu+dilate) remove o texto original, o typeset desenha a tradução com
  **auto-fit** (encolhe a fonte até caber + recuo de ~14% pra não vazar do balão) e gera
  PNGs + **CBZ** em `traduzidos/<manga>/<capitulo>`. Só renderiza falas com tradução final
  preenchida (as não traduzidas ficam intactas). *Refino futuro: typeset por bbox mais
  apertado, hifenização, direção vertical.*
- **Fase 3 — Pipeline plugável + fila** ✅ *implementado*: tradução por **registry
  selecionável via `TRANSLATOR_PROVIDER`** (etapa trocável por config) e **fila de
  pré-processamento por capítulo** — botão **"Pré-processar"** roda detecção + OCR +
  sugestão em TODAS as páginas como job em background (`/api/preprocess-chapter` +
  `/api/job?id=`), salvando o projeto pré-preenchido. **Não sobrescreve** páginas que já
  têm trabalho humano. *(Refino futuro: separar o monólito em módulos `lib/`.)*
- **Fase 4 — Memória inteligente** ✅ *implementado*: **gate de qualidade** (só reusa
  tradução vetada por humano — quando o revisor escreveu/alterou a fala; auto-sugestões
  apenas aceitas não viram memória), **busca fuzzy** (casa apesar de pontuação/ruído do
  OCR: `REUBEN?` == `REUBEN`) e **índice em memória** com cache por mtime (deixou de varrer
  todos os JSONs a cada sugestão) + **glossário por obra**.
- **Fase 5 — Refinos** ✅ *parcial*: **hifenização** de palavras gigantes, fonte mínima
  menor (8px) e **prévia por página** (botão **"Prévia"** → renderiza a página atual com
  inpaint+typeset e mostra na tela, sem exportar — a "leitura dupla" Original | Traduzido).
  *Pendente: direção vertical (japonês), estilo por personagem.*

> **Fluxo recomendado:** abrir capítulo → **Pré-processar** (máquina detecta+OCR+sugere
> tudo) → revisar página a página → **Prévia** pra conferir → **Gerar capítulo** (CBZ).

### Glossário (`tradutor-manga/treino/glossario.json`)

Termos globais + por obra são injetados no prompt da IA. Formato:

```json
{
  "terms": [ { "source": "Marine", "target": "Marinha", "note": "opcional" } ],
  "porObra": {
    "One Piece": [ { "source": "Yonko", "target": "Yonkou" } ]
  }
}
```

`GET /api/training` mostra `humanExamples` / `autoExamples` (quantas falas vetadas por
humano já alimentam a memória) e `glossaryPorObra`.

Referências estudadas: `zyddnys/manga-image-translator` (pipeline modular completo) e
`thradnea/onyx-manga-translator` (pipeline enxuto: YOLO + manga-ocr + cv2.inpaint + TM SQLite).
