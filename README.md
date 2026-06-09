# 📖 Tradutor de Mangá (human-in-the-loop)

Ferramenta **local** para traduzir mangá (EN/JP → **PT-BR**) com qualidade de scanlation.
A máquina entrega o rascunho ~80% pronto — **detecta os balões, lê o texto (OCR), traduz,
apaga o inglês e escreve a tradução no balão** — e você **revisa os 20%** que importam,
balão a balão. O sistema **aprende com as suas correções**.

> Tudo roda na sua máquina. Tradução pela IA local (**Ollama**); sem chave de API e sem
> enviar nada pra nuvem (a não ser que você ligue o fallback do Google/OpenAI).

---

## Como funciona (3 peças)

```
Navegador (você revisa)  ─HTTP→  translator-server.js (Node, :3210)  ─HTTP→  detector/service.py (Python, :5000)
                                          │                                   YOLO (balões) + OCR + inpaint + render
                                          └─HTTP→  Ollama (:11434)  →  tradução (qwen3.5)
```

- **Node** orquestra (tradução, memória, glossário, export).
- **Python** faz a visão: detecta balões (YOLOv8-seg), OCR, apaga o texto original e desenha a
  tradução. O Node **sobe esse serviço sozinho**.
- **Ollama** é a IA local que traduz.

---

## ✅ Pré-requisitos

| Programa | Obrigatório? | Para quê |
|---|---|---|
| **[Node.js](https://nodejs.org) 18+** | **Sim** | servidor/orquestrador |
| **[Python](https://www.python.org/downloads/) 3.10–3.12** | **Sim** | detector de balões + OCR + render |
| **[Ollama](https://ollama.com/download)** | Recomendado | tradução com IA local (sem ele, cai no Google grátis, mais literal) |
| **GPU NVIDIA + driver CUDA** | Opcional | muito mais rápido (CPU funciona, porém lento) |
| **[Tesseract](https://github.com/UB-Mannheim/tesseract/wiki)** | Opcional | OCR de reserva (o padrão é EasyOCR, que vem pelo pip) |

> **Windows** é o caminho mais testado (tem o `.bat` pronto). Em macOS/Linux funciona via
> `npm start` (veja [Rodar](#-rodar)).

---

## 📥 Instalação

### 1) Baixar o projeto
```bash
git clone https://github.com/Tonsoaresmt/Tradu-ao-.git tradutor
cd tradutor
```

### 2) Dependências do Node (servidor)
```bash
npm install
```

### 3) Detector Python (balões + OCR + render)
```bash
cd detector
python -m venv .venv

# Windows:
.venv\Scripts\python -m pip install -r requirements.txt
# macOS/Linux:
# .venv/bin/python -m pip install -r requirements.txt
```

O `requirements.txt` já traz `ultralytics` (que instala o **torch CPU**), `easyocr`,
`pytesseract` e `manga-ocr`. Se o EasyOCR reclamar de `opencv`, instale com
`pip install easyocr --no-deps` e depois
`pip install scikit-image lazy-loader imageio tifffile ninja python-bidi pyclipper shapely`
(ele reaproveita o OpenCV que já veio com o ultralytics).

**GPU NVIDIA (opcional, recomendado)** — troque o torch CPU pelo build CUDA:
```bash
.venv\Scripts\python -m pip install --force-reinstall --no-deps torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\python -c "import torch; print(torch.cuda.is_available())"   # deve imprimir True
```

### 4) Ollama (a IA que traduz)
Instale o [Ollama](https://ollama.com/download) e baixe um modelo:
```bash
ollama pull qwen3.5:9b     # QUALIDADE (≈6.6 GB) — recomendado se você tem GPU 8 GB+
# ou, se a máquina for mais fraca / quiser velocidade:
ollama pull qwen3.5:4b     # rápido, porém erra mais
```
O modelo usado fica definido no `.bat` (`OLLAMA_TRANSLATOR_MODEL`). Se você baixar outro,
edite lá — o servidor valida o que está instalado e avisa.

> **Sem Ollama?** Funciona mesmo assim: a tradução cai automaticamente no **Google grátis**
> (precisa de internet, resultado mais literal). Ollama é o que dá a qualidade boa.

---

## ▶️ Rodar

**Windows (fácil):** dê dois cliques em **`INICIAR-TRADUTOR.bat`**. Ele encerra instâncias
antigas, sobe o servidor e abre o navegador em `http://127.0.0.1:3210`. **Não feche a janela
preta** enquanto traduz (fechá-la = encerrar). O trabalho **salva sozinho a cada ~10 s**.

**Manual (qualquer SO):**
```bash
npm start          # sobe em http://127.0.0.1:3210
```

> **Primeira execução baixa modelos automaticamente:** o de balões
> (`kitsumed/yolov8m_seg-speech-bubble`, ~50 MB) e o do EasyOCR EN (~64 MB). Depois é rápido.

---

## 🚀 Uso (fluxo recomendado)

1. Coloque o mangá de origem em **`tradutor-manga/entrada-originais/<Nome da Obra>/`**
   (um `.cbz` ou uma pasta de imagens por capítulo).
2. Abra o navegador (`http://127.0.0.1:3210`), escolha a obra/capítulo.
3. **Pré-processar** (opcional) — detecta + OCR + traduz todas as páginas de uma vez.
4. **Revise** página a página: cada balão é um campo editável; ajuste o texto, a posição e a
   fonte. Use **"Revisar (9b)"** pra IA reler e corrigir, ou **"Re-traduzir"** pra refazer do zero.
5. **Prévia** mostra a página renderizada (inglês apagado, PT-BR no balão).
6. **Gerar capítulo** exporta os PNGs + um **CBZ** em `tradutor-manga/traduzidos/`.

Suas edições viram **memória de treino** (só correções humanas), então a IA fica mais
consistente nas próximas falas/capítulos.

---

## ⚙️ Configuração (variáveis de ambiente)

Edite o `INICIAR-TRADUTOR.bat` (Windows) ou exporte antes do `npm start`.

| Variável | Default | Para quê |
|---|---|---|
| `TRANSLATOR_PORT` / `TRANSLATOR_HOST` | `3210` / `127.0.0.1` | endereço do servidor |
| `TRANSLATOR_PROVIDER` | `auto` | cadeia de tradução: `auto` (memória→ollama→openai→libre→google) / `ollama` / `google` |
| `OLLAMA_URL` | `127.0.0.1:11434` | endereço do Ollama |
| `OLLAMA_TRANSLATOR_MODEL` | *(autodetecta)* | modelo tradutor, ex. `qwen3.5:9b` |
| `OLLAMA_REVIEWER_MODEL` | *(usa o tradutor)* | modelo do botão **Revisar**, ex. `qwen3.5:9b` |
| `OLLAMA_NUM_CTX` | `8192` | janela de contexto (tokens) |
| `DETECTOR_OCR` | `easyocr` | OCR do detector: `easyocr` / `tesseract` / `manga-ocr` / `none` |
| `DETECTOR_GPU` | *(ligado)* | `0` força o detector na **CPU** (libera a GPU inteira pro Ollama) |
| `OCR_LANG` | `eng` | idioma do Tesseract (ex.: `jpn`) |
| `RENDER_FONT` | comic_shanns | fonte `.ttf` do lettering |
| `USE_OPENAI_TRANSLATOR` / `OPENAI_API_KEY` | — | usar OpenAI (opcional, pago) |

---

## 🖥️ Modelo × hardware (importante)

Numa GPU de **8 GB**, o `qwen3.5:9b` (6.6 GB) e o detector **não cabem juntos**. Por isso o
`.bat` usa **`DETECTOR_GPU=0`** (detector na CPU) pra dar a GPU inteira ao 9b.

- **`qwen3.5:9b`** → tradução **boa**, ~15-17 s/página. Use se prioriza qualidade.
- **`qwen3.5:4b`** → **rápido** (~5 s/pág, cabe junto do detector na GPU), mas **erra mais**.
- Verdade nua: em GPU de 8 GB **não existe "rápido E bom" local**. Pra isso, só API paga (OpenAI/Gemini).

---

## 📁 Estrutura

```
tradutor/
├── INICIAR-TRADUTOR.bat     Lançador Windows (mata antigos, sobe servidor, abre navegador)
├── translator-server.js     Backend Node (HTTP puro, :3210)
├── translator-ui/           SPA de revisão (state/api/library/editor/translator/preview/export.js)
├── detector/
│   ├── service.py           Microserviço Python (:5000): YOLO + OCR + inpaint + typeset + QC
│   ├── requirements.txt      deps Python
│   ├── fonts/               comic_shanns_2.ttf (acentos PT-BR corretos)
│   └── .venv/               ambiente Python  (gitignored, ~1.2 GB — recrie no passo 3)
├── tradutor-manga/          DADOS (gitignored)
│   ├── entrada-originais/    suas obras de origem (.cbz / imagens)
│   ├── em-traducao/          páginas extraídas + projetos .json
│   ├── traduzidos/           saída (CBZ + PNGs)
│   └── treino/               memória: exemplos.jsonl, glossario.json, personagens.json, estilo.txt
└── PADROES-DE-QUALIDADE.md   parâmetros derivados de scans profissionais
```

> O `.venv`, `node_modules`, os modelos (`*.pt`) e a pasta `tradutor-manga/` são
> **gitignored** — por isso a instalação recria o venv e baixa os modelos.

---

## 🔧 Problemas comuns

- **"Detector vermelho / OCR não lê"** — o venv do passo 3 não foi criado, ou o Python não
  é o do `.venv`. Confira `DETECTOR_PYTHON` e rode `pip install -r requirements.txt`.
- **Tradução literal/robótica** — o Ollama não está rodando (caiu no Google). Abra o Ollama
  e confira `ollama list`.
- **`torch.cuda.is_available()` = False** — reinstale o torch CUDA (passo 3, GPU) e confira o
  driver NVIDIA. Sem GPU funciona, só mais devagar.
- **Mudei o código e nada mudou** — feche e reabra o `.bat` (ele mata o servidor antigo) e dê
  **Ctrl+F5** no navegador. Se a obra já foi traduzida, o sistema **não re-traduz** página com
  balões — use **"Re-traduzir"** ou apague o projeto em `em-traducao/projetos/`.
- **Acentos saem como lixo no CBZ** — use uma fonte com acentos PT-BR (a padrão
  `comic_shanns_2.ttf` funciona; algumas fontes de quadrinho mapeiam acentos errado).

---

## 🙏 Créditos

- Detecção: [`kitsumed/yolov8m_seg-speech-bubble`](https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble) (YOLOv8-seg via [ultralytics](https://github.com/ultralytics/ultralytics)).
- OCR: [EasyOCR](https://github.com/JaidedAI/EasyOCR), [manga-ocr](https://github.com/kha-white/manga-ocr) (JP), [Tesseract](https://github.com/tesseract-ocr/tesseract).
- Tradução: [Ollama](https://ollama.com) (modelos Qwen).
- Inspiração: `zyddnys/manga-image-translator` e `thradnea/onyx-manga-translator`.

> Uso pessoal/educacional. Respeite os direitos autorais das obras que você traduzir.
