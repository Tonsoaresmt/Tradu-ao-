"""
Microsserviço de detecção de balões + OCR para o Tradutor de Mangá.

Roda um HTTP server local (stdlib, sem framework). Carrega os modelos UMA vez
e atende /detect. O translator-server.js (Node) consome este serviço; se ele
não estiver de pé, o Node cai no OCR antigo (degradação graciosa).

Contrato de saída (igual ao que o translator-server.js já espera):
  { "lines": [ {originalText, confidence, x, y, width, height}, ... ] }
com x/y/width/height NORMALIZADOS de 0 a 1 em relação à imagem inteira.

Modelos:
  - Detecção de balões: YOLOv8-seg (kitsumed/yolov8m_seg-speech-bubble por padrão)
  - OCR:  'tesseract' (qualquer idioma, ex.: eng/por/jpn)  ou  'manga-ocr' (japonês)

Variáveis de ambiente:
  DETECTOR_PORT   (5000)            porta do serviço
  DETECTOR_HOST   (127.0.0.1)
  BUBBLE_MODEL    (auto via HF)     caminho .pt local OU usa download do HF
  BUBBLE_REPO     (kitsumed/yolov8m_seg-speech-bubble)
  BUBBLE_FILE     (model.pt)        arquivo dentro do repo HF
  OCR_ENGINE      (tesseract)       'tesseract' | 'manga-ocr' | 'none'
  OCR_LANG        (eng)             idioma do tesseract
  YOLO_CONF       (0.15)            confiança mínima de detecção
"""

import io
import os
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DETECTOR_PORT", "5000"))
HOST = os.environ.get("DETECTOR_HOST", "127.0.0.1")
BUBBLE_MODEL = os.environ.get("BUBBLE_MODEL", "")
BUBBLE_REPO = os.environ.get("BUBBLE_REPO", "kitsumed/yolov8m_seg-speech-bubble")
BUBBLE_FILE = os.environ.get("BUBBLE_FILE", "model.pt")
OCR_ENGINE = os.environ.get("OCR_ENGINE", "easyocr").lower()
OCR_LANG = os.environ.get("OCR_LANG", "eng")
YOLO_CONF = float(os.environ.get("YOLO_CONF", "0.15"))

# Estado global dos modelos (carregados sob demanda, uma única vez).
_state = {
    "yolo": None,
    "yolo_error": None,
    "ocr_engines": {},   # nome -> objeto carregado ('tesseract' sentinel p/ tesseract)
    "ocr_errors": {},    # nome -> mensagem de erro
    "default_engine": OCR_ENGINE,
}


def log(msg):
    print(f"[detector] {msg}", flush=True)


def resolve_bubble_model():
    """Caminho do .pt: usa BUBBLE_MODEL local, senão baixa do HuggingFace."""
    if BUBBLE_MODEL and os.path.exists(BUBBLE_MODEL):
        return BUBBLE_MODEL
    from huggingface_hub import hf_hub_download
    log(f"baixando modelo de balões {BUBBLE_REPO}/{BUBBLE_FILE} (primeira vez pode demorar)...")
    return hf_hub_download(repo_id=BUBBLE_REPO, filename=BUBBLE_FILE)


def load_yolo():
    if _state["yolo"] is not None or _state["yolo_error"] is not None:
        return _state["yolo"]
    try:
        from ultralytics import YOLO
        path = resolve_bubble_model()
        log(f"carregando YOLO de {path}")
        _state["yolo"] = YOLO(path)
        log("YOLO pronto.")
    except Exception as e:
        _state["yolo_error"] = str(e)
        log(f"falha ao carregar YOLO: {e}")
    return _state["yolo"]


def _configure_tesseract(pytesseract):
    """Aponta o pytesseract pro binario, mesmo fora do PATH (install padrao Windows)."""
    tess_cmd = os.environ.get("TESSERACT_CMD", "")
    if not tess_cmd:
        for cand in (
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        ):
            if os.path.exists(cand):
                tess_cmd = cand
                break
    if tess_cmd:
        pytesseract.pytesseract.tesseract_cmd = tess_cmd


def get_ocr(engine):
    """Carrega/cacheia o engine OCR pedido (tesseract|manga-ocr); trocavel por requisicao."""
    engine = (engine or "").lower()
    if engine in ("", "none"):
        return None
    if engine in _state["ocr_engines"]:
        return _state["ocr_engines"][engine]
    if engine in _state["ocr_errors"]:
        return None
    try:
        if engine == "manga-ocr":
            from manga_ocr import MangaOcr
            log("carregando manga-ocr (japones, baixa o modelo na 1a vez)...")
            obj = MangaOcr()
            _state["ocr_engines"][engine] = obj
            log("manga-ocr pronto.")
            return obj
        if engine in ("easyocr", "easyocr-pt"):
            import easyocr
            gpu = False
            try:
                import torch
                gpu = bool(torch.cuda.is_available())
            except Exception:
                gpu = False
            # 'easyocr' = ingles; 'easyocr-pt' = portugues (latin_g2, com acentos) —
            # usado p/ ler a TRADUCAO DE REFERENCIA do estudio (aprender estilo).
            langs = ["pt"] if engine == "easyocr-pt" else ["en"]
            log(f"carregando easyocr {langs} (IA, gpu={gpu}; baixa o modelo na 1a vez)...")
            reader = easyocr.Reader(langs, gpu=gpu, verbose=False)
            _state["ocr_engines"][engine] = reader
            log(f"easyocr {langs} pronto.")
            return reader
        if engine == "tesseract":
            import pytesseract
            _configure_tesseract(pytesseract)
            pytesseract.get_tesseract_version()  # valida o binario
            _state["ocr_engines"][engine] = "tesseract"
            log(f"tesseract pronto (bin={pytesseract.pytesseract.tesseract_cmd}).")
            return "tesseract"
        _state["ocr_errors"][engine] = f"engine OCR desconhecido: {engine}"
    except Exception as e:
        _state["ocr_errors"][engine] = str(e)
        log(f"OCR '{engine}' indisponivel: {e}")
    return None


def _prep_for_tesseract(pil_image):
    """Prepara o recorte para o Tesseract: cinza -> AMPLIA (texto pequeno) ->
    binariza (Otsu, texto preto em fundo branco) -> borda branca. Sem isso o
    Tesseract erra muito em lettering pequeno/estilizado de mangá."""
    import numpy as np
    import cv2
    from PIL import Image
    g = np.array(pil_image.convert("L"))
    h, w = g.shape[:2]
    if max(h, w) < 1000:                       # texto fica grande o bastante p/ o OCR
        s = 1000.0 / max(h, w)
        g = cv2.resize(g, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_CUBIC)
    g = cv2.bilateralFilter(g, 5, 40, 40)      # suaviza ruido preservando borda das letras
    th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    if (th == 0).mean() > 0.55:                # fundo escuro (texto branco) -> inverte
        th = cv2.bitwise_not(th)
    th = cv2.copyMakeBorder(th, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)
    return Image.fromarray(th)


def _clean_ocr_text(text):
    """Limpeza comum do texto de OCR (qualquer engine)."""
    import re
    text = re.sub(r"[|\\_~{}\[\]<>]", "", text)        # ruído comum de OCR
    text = " ".join(text.split()).strip()
    # EasyOCR/Tesseract leem o "." final como ":" -> normaliza
    # (balão de fala praticamente nunca termina em ":")
    text = re.sub(r"\s*:+\s*$", ".", text)
    return text


def _tesseract_text(pil_image, psm):
    import pytesseract
    text = pytesseract.image_to_string(pil_image, lang=OCR_LANG, config=f"--oem 1 --psm {psm}")
    return _clean_ocr_text(text)


def ocr_crop(engine, pil_image):
    """Roda OCR num recorte de balão com o engine pedido. Retorna texto limpo (ou '')."""
    ocr = get_ocr(engine)
    if ocr is None:
        return ""
    try:
        if engine == "manga-ocr":
            return (ocr(pil_image) or "").strip()
        if engine.startswith("easyocr"):
            import numpy as np
            import cv2
            arr = np.array(pil_image.convert("RGB"))
            h, w = arr.shape[:2]
            if max(h, w) < 720:                  # amplia texto pequeno (ajuda o detector)
                s = 720.0 / max(h, w)
                arr = cv2.resize(arr, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_CUBIC)
            results = ocr.readtext(arr, detail=1, paragraph=False)
            results.sort(key=lambda r: (r[0][0][1], r[0][0][0]))  # ordem de leitura: cima->baixo
            parts = [t for (_b, t, conf) in results if conf >= 0.3]
            return _clean_ocr_text(" ".join(parts))
        if engine == "tesseract":
            prepped = _prep_for_tesseract(pil_image)
            cands = [_tesseract_text(prepped, 6)]    # PSM 6: bloco uniforme (bom p/ balão)
            if len(cands[0]) < 3:                    # texto curto: tenta outros modos
                cands.append(_tesseract_text(prepped, 7))   # 7: linha única
                cands.append(_tesseract_text(prepped, 11))  # 11: texto esparso
            return max(cands, key=len)
    except Exception as e:
        log(f"OCR falhou num recorte: {e}")
    return ""


def classify_box(crop_bgr, text=""):
    """Tipo automatico CONSERVADOR. O modelo detecta BALOES DE FALA, entao o padrao
    e 'fala'; so vira 'grito' quando o contorno do balao e claramente ESPETADO
    (balao explosivo) — sinal confiavel, independe do fundo. narracao/SFX ficam
    manuais (forma nao distingue de fala quando o fundo do painel e claro)."""
    import cv2
    import numpy as np
    try:
        h, w = crop_bgr.shape[:2]
        if h < 16 or w < 16:
            return "fala"
        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        _, bright = cv2.threshold(gray, 188, 255, cv2.THRESH_BINARY)
        # fecha so os buracos do texto (kernel pequeno) pra preservar a forma do contorno
        mask = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            return "fala"
        c = max(cnts, key=cv2.contourArea)
        area = cv2.contourArea(c)
        if area < 0.3 * h * w:
            return "fala"
        hull = cv2.convexHull(c)
        ha = cv2.contourArea(hull)
        solidity = area / ha if ha > 0 else 1.0
        if solidity < 0.78:   # contorno bem espetado -> grito (balao explosivo)
            return "grito"
        return "fala"
    except Exception:
        return "fala"


def detect(image_path, engine=None):
    from PIL import Image

    yolo = load_yolo()
    if yolo is None:
        raise RuntimeError(_state["yolo_error"] or "YOLO não carregou")
    engine = (engine or _state["default_engine"])
    get_ocr(engine)

    image = Image.open(image_path).convert("RGB")
    W, H = image.size

    results = yolo(image_path, conf=YOLO_CONF, iou=0.7, agnostic_nms=True, max_det=50, verbose=False)
    lines = []
    if results and len(results) and results[0].boxes is not None:
        boxes = results[0].boxes
        xyxy = boxes.xyxy.cpu().numpy().tolist()
        confs = boxes.conf.cpu().numpy().tolist()
        for (x1, y1, x2, y2), conf in zip(xyxy, confs):
            x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
            crop = image.crop((int(x1), int(y1), int(x2), int(y2)))
            # Aperta a caixa na AREA BRANCA do balao + classifica o tipo (forma).
            bx1, by1, bx2, by2 = x1, y1, x2, y2
            btype = "fala"
            inner = None
            try:
                import numpy as np
                import cv2
                crop_bgr = cv2.cvtColor(np.array(crop), cv2.COLOR_RGB2BGR)
                inner = bubble_inner_rect(crop_bgr)
                if inner:
                    ix, iy, iw, ih = inner
                    bx1, by1 = x1 + ix, y1 + iy
                    bx2, by2 = x1 + ix + iw, y1 + iy + ih
                btype = classify_box(crop_bgr, "")
            except Exception:
                pass
            # OCR na AREA INTERNA do balão (sem o fundo ao redor, que confunde o
            # Tesseract); se não vier nada, tenta o recorte inteiro do YOLO.
            cw, ch = crop.size
            ocr_src = crop
            if inner:
                ix, iy, iw, ih = inner
                pad = 4
                ocr_src = crop.crop((
                    max(0, int(ix - pad)), max(0, int(iy - pad)),
                    min(cw, int(ix + iw + pad)), min(ch, int(iy + ih + pad))
                ))
            text = ocr_crop(engine, ocr_src)
            if not text and ocr_src is not crop:
                text = ocr_crop(engine, crop)
            # Reserva: se o motor principal (ex.: easyocr) falhar num balão,
            # tenta o Tesseract — o melhor dos dois mundos.
            if not text and engine not in ("tesseract", "none", ""):
                text = ocr_crop("tesseract", ocr_src) or ocr_crop("tesseract", crop)
            lines.append({
                "originalText": text,
                "confidence": round(conf * 100),
                "type": btype,
                "x": max(0.0, min(1.0, bx1 / W)),
                "y": max(0.0, min(1.0, by1 / H)),
                "width": max(0.02, min(1.0, (bx2 - bx1) / W)),
                "height": max(0.02, min(1.0, (by2 - by1) / H)),
            })

    # Ordem de leitura: cima→baixo, esquerda→direita (igual ao server atual).
    lines.sort(key=lambda l: (round(l["y"], 2), l["x"]))
    return lines


# === Render: inpaint do texto original + typeset da traducao ==========
# Tecnica do onyx-manga-translator: cv2.inpaint (Otsu+dilate) limpa o texto
# do balao; PIL desenha a traducao com auto-fit (encolhe a fonte ate caber).

RENDER_FONT = os.environ.get("RENDER_FONT", "")


def find_font():
    if RENDER_FONT and os.path.exists(RENDER_FONT):
        return RENDER_FONT
    here = os.path.dirname(os.path.abspath(__file__))
    # IMPORTANTE (PT-BR): comic_shanns_2 tem os ACENTOS corretos. As fontes
    # anime_ace.ttf/anime_ace_3.ttf afirmam ter os caracteres no cmap, mas
    # mapeiam os acentuados (Ê Ã Ç É ...) pra glifos ERRADOS (cirílico/grego),
    # entao saem como lixo em PT-BR — NAO usar no auto-pick.
    for name in ("comic_shanns_2.ttf",):
        cand = os.path.join(here, "fonts", name)
        if os.path.exists(cand):
            return cand
    win_fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    for name in ("comicbd.ttf", "arialbd.ttf", "ariblk.ttf", "arial.ttf"):
        cand = os.path.join(win_fonts, name)
        if os.path.exists(cand):
            return cand
    return None  # PIL cai na fonte default


# ===== Lettering profissional: quebra balanceada, ocupacao alvo, fonte minima =====
TARGET_FILL = 0.72       # ocupacao alvo (fallback; render_image passa 'fill' por tipo)
MIN_FONT_BASE = 14       # fonte minima legivel (px); cresce com a resolucao
ABS_MIN_FONT = 10        # piso ABSOLUTO: encolhe ate aqui p/ NAO quebrar palavra curta


def _line_spacing(size):
    return max(2, int(size * 0.16))


def _greedy_wrap(words, font, max_width):
    lines, current = [], ""
    for word in words:
        test = (current + " " + word).strip()
        if not current or font.getbbox(test)[2] <= max_width:
            current = test
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def balanced_wrap(text, font, max_width):
    """Quebra em linhas de larguras parecidas (estetica de scan), sem cortar palavra.
    Acha a menor largura-alvo que ainda usa o mesmo numero de linhas do greedy."""
    words = str(text).split()
    if not words:
        return []
    base = _greedy_wrap(words, font, max_width)
    if len(base) <= 1:
        return base
    n = len(base)
    lo = max(font.getbbox(w)[2] for w in words)  # nao menor que a maior palavra
    hi = int(max_width)
    best = base
    while lo <= hi:
        mid = (lo + hi) // 2
        cand = _greedy_wrap(words, font, mid)
        if len(cand) <= n:
            best = cand
            hi = mid - 1
        else:
            lo = mid + 1
    return best


def _max_line_width(lines, font):
    return max((font.getbbox(line)[2] for line in lines), default=0)


def _has_orphan(lines):
    """True se ha linha 'orfa' (<3 chars) no meio de varias — feio ('O'/'SIGNIFICADO')."""
    real = [l.strip() for l in lines if l.strip()]
    return len(real) > 1 and any(len(l) < 3 for l in real)


def _hard_break(lines, font, max_width):
    """Ultimo recurso: corta SO palavra LONGA (>10), com hifen, sem deixar pedaco
    <3 chars. Palavra curta que nao cabe fica inteira (vaza um pouco — bem menos
    feio que 'APLAUS-/E'); o que evita isso de verdade e encolher ate ABS_MIN_FONT."""
    out = []
    for line in lines:
        while font.getbbox(line + "-")[2] > max_width and len(line) > 10:
            cut = len(line) - 1
            while cut > 3 and font.getbbox(line[:cut] + "-")[2] > max_width:
                cut -= 1
            if cut < 3 or (len(line) - cut) < 3:   # nao cria orfa de 1-2 chars
                break
            out.append(line[:cut] + "-")
            line = line[cut:]
        out.append(line)
    return out


def fit_text(draw, text, font_path, box_w, box_h, min_size=MIN_FONT_BASE, max_size=64, fill=TARGET_FILL):
    """Maior fonte (>= min_size) cujo texto BALANCEADO cabe na area util do balao,
    deixando margem confortavel (fill). No piso, gera mais linhas / hifeniza
    em vez de reduzir a fonte indefinidamente. Retorna (font, wrapped, tw, th, spacing)."""
    from PIL import ImageFont
    margin = (1 - fill ** 0.5) / 2   # margem por lado p/ ocupar ~fill da area
    avail_w = max(8, box_w * (1 - 2 * margin))
    avail_h = max(8, box_h * (1 - 2 * margin))

    floor = min(min_size, ABS_MIN_FONT)   # encolhe abaixo do "legivel" ANTES de quebrar
    best_any = None
    size = max(floor, min(int(box_h * 0.85), max_size))
    while size >= floor:
        font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        spacing = _line_spacing(size)
        lines = balanced_wrap(text, font, avail_w)
        wrapped = "\n".join(lines)
        bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=spacing)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if _max_line_width(lines, font) <= avail_w and th <= avail_h:
            cand = (font, wrapped, tw, th, spacing)
            if not _has_orphan(lines):
                return cand                       # melhor: cabe intacto, sem orfa
            if best_any is None and size >= min_size:
                best_any = cand
        if not font_path:
            break
        size -= 1
    if best_any:
        return best_any

    font = ImageFont.truetype(font_path, floor) if font_path else ImageFont.load_default()
    spacing = _line_spacing(floor)
    lines = _hard_break(balanced_wrap(text, font, avail_w), font, avail_w)
    wrapped = "\n".join(lines)
    bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=spacing)
    return font, wrapped, bbox[2] - bbox[0], bbox[3] - bbox[1], spacing


def fit_text_ellipse(draw, text, font_path, box_w, box_h,
                     min_size=MIN_FONT_BASE, max_size=64, k=0.92):
    """Lettering profissional: inscreve o texto na ELIPSE do balão. Cada linha é
    centralizada e sua largura respeita a largura da elipse NAQUELA altura — gera
    o formato oval (linhas curtas em cima/baixo, largas no meio), como nas scans
    profissionais, e NUNCA encosta na borda. Retorna (font, wrapped, tw, th, spacing)
    ou None se não couber de jeito nenhum (aí o chamador usa o encaixe retangular)."""
    from PIL import ImageFont
    words = str(text).split()
    if not words:
        return None
    a = (box_w / 2.0) * k          # semi-eixo horizontal util
    b = (box_h / 2.0) * k          # semi-eixo vertical util
    if a < 4 or b < 4:
        return None

    floor = min(min_size, ABS_MIN_FONT)
    best_any = None
    size = max(floor, min(int(box_h * 0.9), max_size))
    while size >= floor:
        font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        spacing = _line_spacing(size)
        pitch = size + spacing
        max_lines = max(1, int((2 * b) // pitch))
        for n in range(1, max_lines + 1):
            block_h = n * size + (n - 1) * spacing
            if block_h > 2 * b:
                break
            top = -block_h / 2.0
            # largura util da elipse no centro vertical de cada linha
            avail = []
            for j in range(n):
                yc = top + j * pitch + size / 2.0
                r = 1.0 - (yc / b) ** 2
                avail.append((2.0 * a * (r ** 0.5)) if r > 0 else 0.0)
            # encaixe guloso respeitando o cap de largura de cada linha
            lines = [""] * n
            idx = 0
            ok = True
            for w in words:
                if idx >= n:
                    ok = False
                    break
                cand = (lines[idx] + " " + w).strip()
                if font.getbbox(cand)[2] <= avail[idx]:
                    lines[idx] = cand
                elif lines[idx]:
                    idx += 1
                    if idx >= n or font.getbbox(w)[2] > avail[idx]:
                        ok = False
                        break
                    lines[idx] = w
                else:
                    ok = False  # palavra sozinha não cabe na linha estreita
                    break
            if ok and all(lines):   # usou exatamente as n linhas, todas cheias
                wrapped = "\n".join(lines)
                bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=spacing)
                cand = (font, wrapped, bbox[2] - bbox[0], bbox[3] - bbox[1], spacing)
                if not _has_orphan(lines):
                    return cand                       # melhor caso: sem linha orfa
                if best_any is None and size >= min_size:
                    best_any = cand                   # orfa (ex.: 2 palavras) so ACIMA do piso
        size -= 1
    return best_any


def bubble_inner_rect(crop_bgr):
    """Acha a area branca interna do balao dentro do recorte (x,y,w,h) ou None."""
    import cv2
    import numpy as np
    if crop_bgr is None or crop_bgr.size == 0:
        return None
    h, w = crop_bgr.shape[:2]
    if h < 6 or w < 6:
        return None
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    _, bright = cv2.threshold(gray, 188, 255, cv2.THRESH_BINARY)
    # fecha os buracos deixados pelo texto pra unir a area branca do balao
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    cnts, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(c) < 0.22 * w * h:
        return None  # pouca area branca -> balao colorido/efeito: usa fallback
    return cv2.boundingRect(c)


def render_image(image_path, boxes, font_path, typeset=True):
    import numpy as np
    import cv2
    from PIL import Image, ImageDraw

    pil = Image.open(image_path).convert("RGB")
    W, H = pil.size
    img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

    def px(box):
        x1 = int(max(0.0, min(1.0, box.get("x", 0))) * W)
        y1 = int(max(0.0, min(1.0, box.get("y", 0))) * H)
        x2 = int(min(W, x1 + max(0.01, box.get("width", 0.1)) * W))
        y2 = int(min(H, y1 + max(0.01, box.get("height", 0.1)) * H))
        return x1, y1, x2, y2

    # 1) COBRIR (nao reconstruir) o texto original. Filosofia: mexer o MINIMO.
    # So tapa a MANCHA DAS LETRAS dentro da AREA BRANCA do balao DETECTADO, usando
    # o proprio fundo (branco) do balao. NUNCA toca: a borda/anel do balao, a arte
    # que invade, nem NADA FORA do balao (SFX, cenario, legenda). Sem inpaint.
    orig_font = {}   # id(box) -> tamanho de fonte medido do texto ORIGINAL (px)
    orig_weight = {} # id(box) -> peso (espessura do traco / altura) do lettering original
    for box in boxes:
        # No typeset, so cobre balao ja traduzido; no modo fundo-do-editor
        # (typeset=False) cobre TODO balao detectado (tira o ingles de uma vez).
        if typeset and not str(box.get("translatedText", "")).strip():
            continue
        if box.get("coverOriginal") is False:
            continue
        if (box.get("type") or "fala").lower() == "sfx":
            continue  # SFX nao e dialogo -> preserva a arte original
        x1, y1, x2, y2 = px(box)
        if x2 <= x1 or y2 <= y1:
            continue
        # AREA BRANCA INTERNA do balao. Se NAO houver (balao colorido, texto sobre
        # arte, ou caixa que nao e balao de fala): NAO arrisca -> pula, deixa o
        # original intacto. Isso impede apagar SFX/cenario/texto fora de balao.
        inner = bubble_inner_rect(img[y1:y2, x1:x2])
        if not inner:
            continue
        ix, iy, iw, ih = inner
        pad = max(2, int(min(iw, ih) * 0.07))   # recuo: protege o anel/borda do balao
        rx1, ry1 = x1 + ix + pad, y1 + iy + pad
        rx2, ry2 = x1 + ix + iw - pad, y1 + iy + ih - pad
        if rx2 - rx1 < 4 or ry2 - ry1 < 4:
            continue
        crop = img[ry1:ry2, rx1:rx2]            # VIEW de img -> alteracoes valem in-place
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        mh, mw = mask.shape
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        text_mask = np.zeros_like(mask)
        letter_h = []
        for i in range(1, n):
            cx, cy, cw, ch, area = stats[i]
            # BLOB GRANDE = arte/silhueta de personagem invadindo o balao -> PRESERVA.
            if cw > mw * 0.62 or ch > mh * 0.62 or area > 0.16 * mw * mh:
                continue
            text_mask[labels == i] = 255
            if ch >= 4 and ch < mh * 0.5:        # altura de letra plausivel
                letter_h.append(ch)
        if not text_mask.any():
            continue                             # nada que pareca texto -> nao mexe
        # Fonte do ORIGINAL: mediana da altura das letras / ~0.70 (alvo de tamanho)
        # + PESO: espessura mediana do traco (distance transform) / altura -> razao
        # reproduzida no typeset como faux-bold (segue o "encorpado" da obra).
        if letter_h:
            letter_h.sort()
            cap_h = letter_h[len(letter_h) // 2]
            orig_font[id(box)] = max(MIN_FONT_BASE, int(round(cap_h / 0.70)))
            dt = cv2.distanceTransform(text_mask, cv2.DIST_L2, 3)
            dvals = dt[dt > 0.5]
            if dvals.size:
                stroke = float(np.median(dvals)) * 2.0
                orig_weight[id(box)] = max(0.06, min(0.22, stroke / max(1.0, cap_h)))
        # Cor de fundo do balao = mediana dos pixels NAO-texto (o branco do balao).
        bgpx = crop[mask == 0]
        bg = (np.median(bgpx.reshape(-1, 3), axis=0).astype(np.uint8)
              if bgpx.size else np.array([255, 255, 255], dtype=np.uint8))
        # TAPA so os pixels de texto (levemente dilatados) com o fundo do balao.
        text_mask = cv2.dilate(text_mask, np.ones((3, 3), np.uint8), iterations=2)
        crop[text_mask > 0] = bg

    # 2) typeset da traducao
    out = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if not typeset:
        # Modo "fundo do editor": so o inpaint (ingles removido, arte/rosto
        # preservados) — o texto editavel e desenhado por cima pela UI.
        return out, 0, []
    draw = ImageDraw.Draw(out)
    rendered = 0
    issues = []
    K_ELLIPSE = 0.91                 # ocupacao do balao (margem confortavel, nao encosta na borda)
    min_font = max(MIN_FONT_BASE, int(H * 0.016))

    # --- Precomputa area + parametros de cada caixa com texto (uma vez) ---
    items = []
    for box in boxes:
        text = str(box.get("translatedText", "")).strip()
        if not text:
            continue
        text = text.upper()                 # lettering de scan: CAIXA ALTA
        btype = (box.get("type") or "fala").lower()
        is_sfx = btype == "sfx"
        is_bubble = btype in ("fala", "pensamento")
        x1, y1, x2, y2 = px(box)
        if is_sfx:
            ax1, ay1, aw, ah = x1, y1, (x2 - x1), (y2 - y1)
        else:
            inner = bubble_inner_rect(img[y1:y2, x1:x2]) if box.get("coverOriginal") is not False else None
            if inner:
                ix, iy, iw, ih = inner
                ax1, ay1, aw, ah = x1 + ix, y1 + iy, iw, ih
            else:
                ax1, ay1, aw, ah = x1, y1, (x2 - x1), (y2 - y1)
        if aw < 8 or ah < 8:
            continue
        if btype == "grito":
            max_font, stroke_div, fill = max(44, int(H * 0.085)), 7, 0.9
        elif is_sfx:
            max_font, stroke_div, fill = max(22, int(H * 0.05)), 6, 0.9
        elif btype == "narracao":
            max_font, stroke_div, fill = max(30, int(H * 0.05)), 18, 0.94
        else:  # fala / pensamento
            max_font, stroke_div, fill = max(34, int(H * 0.06)), 16, 0.94
        items.append({
            "box": box, "text": text, "btype": btype, "is_sfx": is_sfx, "is_bubble": is_bubble,
            "area": (ax1, ay1, aw, ah), "max_font": max_font, "fill": fill, "stroke_div": stroke_div,
            "orig_font": orig_font.get(id(box)),     # tamanho medido do texto original
            "orig_weight": orig_weight.get(id(box)), # peso (espessura do traco) do original
        })

    # --- Pass 1: TAMANHO UNIFORME dos baloes de fala da pagina (estetica scan) ---
    # Cada balao "comporta" uma fonte; usamos um alvo comum (percentil ~35) pra
    # todos ficarem no MESMO tamanho, sem o balao gigante puxar tudo pra cima.
    sizes = []
    for it in items:
        if not it["is_bubble"]:
            continue
        ax1, ay1, aw, ah = it["area"]
        fw, fh = aw * 0.84, ah * 0.84           # mesma margem do desenho (mfrac 0.08/lado)
        r = fit_text(draw, it["text"], font_path, fw, fh,
                     min_size=min_font, max_size=it["max_font"], fill=it["fill"])
        if r:
            sizes.append(getattr(r[0], "size", 0))
    uniform = None
    if len([s for s in sizes if s]) >= 2:
        ss = sorted(s for s in sizes if s)
        uniform = ss[int(len(ss) * 0.35)]

    # --- Pass 2: desenha (baloes no tamanho uniforme; resto no seu encaixe) ---
    for it in items:
        box = it["box"]; text = it["text"]; btype = it["btype"]
        is_sfx = it["is_sfx"]; is_bubble = it["is_bubble"]
        ax1, ay1, aw, ah = it["area"]
        max_font = it["max_font"]; fill = it["fill"]; stroke_div = it["stroke_div"]

        # ALVO de fonte: 1) tamanho MANUAL (fontLocked, o humano mandou) tem
        # prioridade; 2) tamanho do ORIGINAL medido; 3) uniforme da pagina.
        manual = box.get("fontLocked") and box.get("fontSize")
        target = it.get("orig_font")
        if manual:
            cap = max(min_font, min(int(box.get("fontSize") or 18), int(H * 0.2)))
        elif target:
            cap = max(min_font, min(int(target), int(H * 0.14)))
        elif uniform and is_bubble:
            cap = min(max_font, uniform)
        else:
            cap = max_font

        # CONSISTENCIA (global, vale p/ qualquer obra): prende a fonte de cada
        # BALAO numa faixa em torno do consenso da pagina (uniform). A fonte medida
        # do original as vezes sai pequena demais em fala curta -> gera o "fonte
        # destoa / SEMPRE minusculo". O encaixe (fit_text_ellipse/fit_text) ainda
        # encolhe se nao couber no balao, entao subir o teto NUNCA causa transbordo.
        if uniform and is_bubble and not manual:
            cap = int(max(uniform * 0.8, min(cap, uniform * 1.4)))
            cap = max(min_font, min(cap, max_font))

        # Encaixe RETANGULAR centralizado (caixa de dialogo) — sem forcar oval.
        method = "rect"
        mfrac = 0.0 if is_sfx else (0.08 if is_bubble else 0.07)
        mx, my = int(aw * mfrac), int(ah * mfrac)
        fx1, fy1, fw, fh = ax1 + mx, ay1 + my, aw - 2 * mx, ah - 2 * my
        res = fit_text(draw, text, font_path, fw, fh,
                       min_size=min_font, max_size=cap, fill=fill)

        # OCUPACAO (padrao de estudio): fala curta em balao grande ficava
        # minuscula porque o teto vinha do tamanho medido no ORIGINAL. Se o
        # bloco ficou ESPARSO (< 28% da altura util), deixa a fonte crescer
        # alem do original — com limite (x1.6) pra nao destoar da pagina.
        if res and not manual:
            _sz = getattr(res[0], "size", 0)
            if res[3] < 0.28 * fh and _sz and _sz < max_font:
                boost = min(max_font, max(int(_sz * 1.6), _sz + 4))
                res = fit_text(draw, text, font_path, fw, fh,
                               min_size=min_font, max_size=boost, fill=fill)

        font, wrapped, tw, th, spacing = res
        # centraliza o bloco na area (centro visual do balao)
        tx = fx1 + (fw - tw) / 2
        ty = fy1 + (fh - th) / 2
        # GROSSURA (faux-bold) CONTROLAVEL. SFX/grito = contorno BRANCO (le sobre a
        # arte). Balao de fala = faux-bold PRETO: 1) box.fontWeight (humano manda, em
        # px) tem prioridade; 2) senao auto SUTIL — so engrossa um tico se o lettering
        # ORIGINAL e encorpado. Default leve: stroke grosso "borra" junçoes (ex.: o M).
        fsize = getattr(font, "size", 14)
        if is_sfx or btype == "grito":
            sw, stroke_fill = max(2, fsize // stroke_div), "white"
        else:
            mw = box.get("fontWeight")
            if mw is not None:
                sw = max(0, int(round(float(mw))))        # humano controla (px)
            else:
                weight = it.get("orig_weight") or 0.10
                sw = 1 if weight >= 0.13 else 0           # auto sutil (so original encorpado)
            sw = min(sw, max(1, fsize // 8))              # teto anti-borrao
            stroke_fill = "black"
        draw.multiline_text((tx, ty), wrapped, font=font, fill="black",
                            align="center", spacing=spacing, stroke_width=sw, stroke_fill=stroke_fill)
        rendered += 1

        # ---- QC: confere se ficou no padrao (REVISOR FINAL geometrico) ----
        problems = []
        if tw > fw + 2 or th > fh + 2:
            problems.append("texto transborda o balao")
        if getattr(font, "size", 99) <= min_font and (tw > fw * 0.97 or th > fh * 0.97):
            problems.append("nao coube nem na fonte minima (encurte a traducao)")
        if (th / float(ah) if ah else 0) < 0.18:
            problems.append("texto pequeno demais para o balao")
        if uniform and is_bubble and getattr(font, "size", 0) < uniform * 0.7:
            problems.append("fonte destoa das outras (muito menor) — revise o balao")
        if _has_orphan(wrapped.split("\n")):
            problems.append("linha isolada muito curta (rebalancear/encurtar)")
        if problems:
            issues.append({"box": box.get("order") or rendered, "type": btype, "problems": problems})

    return out, rendered, issues


def render_page(image_path, boxes, out_path, font_path):
    out, rendered, issues = render_image(image_path, boxes, font_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out.save(out_path)
    return rendered, issues


def render_png_bytes(image_path, boxes, font_path, typeset=True):
    import io
    out, rendered, issues = render_image(image_path, boxes, font_path, typeset=typeset)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue(), rendered, issues


def pack_cbz(files, cbz_path):
    import zipfile
    os.makedirs(os.path.dirname(cbz_path), exist_ok=True)
    with zipfile.ZipFile(cbz_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(f, os.path.basename(f))
    return cbz_path


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # silencia o log padrão (ruidoso)

    def do_GET(self):
        if self.path.startswith("/health"):
            default = _state["default_engine"]
            gpu = False
            try:
                import torch
                gpu = bool(torch.cuda.is_available())
            except Exception:
                gpu = False
            self._send(200, {
                "ok": True,
                "yolo": _state["yolo"] is not None,
                "yoloError": _state["yolo_error"],
                "gpu": gpu,
                "ocrEngine": default,
                "ocrReady": default in _state["ocr_engines"],
                "ocrLoaded": list(_state["ocr_engines"].keys()),
                "ocrError": _state["ocr_errors"].get(default),
                "ocrErrors": _state["ocr_errors"],
            })
            return
        self._send(404, {"error": "rota não encontrada"})

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def do_POST(self):
        if self.path.startswith("/detect"):
            self._handle_detect()
        elif self.path.startswith("/export"):
            self._handle_export()
        elif self.path.startswith("/render-one"):
            self._handle_render_one()
        else:
            self._send(404, {"error": "rota não encontrada"})

    def _handle_detect(self):
        try:
            body = self._read_body()
            image_path = body.get("imagePath", "")
            engine = str(body.get("ocr") or _state["default_engine"]).lower()
            if not image_path or not os.path.exists(image_path):
                self._send(400, {"error": f"imagem não encontrada: {image_path}"})
                return
            lines = detect(image_path, engine)
            used = get_ocr(engine) is not None
            self._send(200, {
                "ok": True,
                "provider": f"yolo+{engine if used else 'no-ocr'}",
                "lines": lines,
            })
        except Exception as e:
            log("erro no /detect:\n" + traceback.format_exc())
            self._send(500, {"error": str(e)})

    def _handle_export(self):
        try:
            body = self._read_body()
            pages = body.get("pages", [])
            output_dir = body.get("outputDir", "")
            cbz_path = body.get("cbzPath") or None
            font_path = body.get("font") or find_font()
            if not pages or not output_dir:
                self._send(400, {"error": "pages e outputDir sao obrigatorios"})
                return
            written = []
            total_boxes = 0
            qc = []   # verificacao: baloes que NAO ficaram no padrao
            for page in pages:
                image_path = page.get("imagePath", "")
                if not image_path or not os.path.exists(image_path):
                    continue
                out_name = page.get("outName") or (os.path.splitext(os.path.basename(image_path))[0] + ".png")
                out_path = os.path.join(output_dir, out_name)
                rendered, issues = render_page(image_path, page.get("boxes", []), out_path, font_path)
                total_boxes += rendered
                for it in issues:
                    qc.append({"page": out_name, **it})
                written.append(out_path)
            cbz_out = pack_cbz(written, cbz_path) if (cbz_path and written) else None
            self._send(200, {
                "ok": True,
                "pages": len(written),
                "boxesRendered": total_boxes,
                "outputDir": output_dir,
                "cbz": cbz_out,
                "font": font_path,
                "qcIssues": qc,
                "qcOk": len(qc) == 0,
            })
        except Exception as e:
            log("erro no /export:\n" + traceback.format_exc())
            self._send(500, {"error": str(e)})

    def _handle_render_one(self):
        try:
            body = self._read_body()
            image_path = body.get("imagePath", "")
            if not image_path or not os.path.exists(image_path):
                self._send(400, {"error": f"imagem nao encontrada: {image_path}"})
                return
            typeset = body.get("typeset", True)
            boxes = body.get("boxes", [])
            font_path = body.get("font") or find_font()
            # Modo "so QC": roda o render p/ obter o veredito SEM gerar/transmitir
            # o PNG (rapido nas iteracoes do loop de auto-ajuste).
            if body.get("qcOnly"):
                _out, rendered, issues = render_image(image_path, boxes, font_path, typeset=typeset)
                self._send(200, {"ok": True, "boxesRendered": rendered, "qcIssues": issues, "qcOk": len(issues) == 0})
                return
            import base64
            png, rendered, issues = render_png_bytes(image_path, boxes, font_path, typeset=typeset)
            self._send(200, {
                "ok": True,
                "boxesRendered": rendered,
                "qcIssues": issues,
                "qcOk": len(issues) == 0,
                "dataUrl": "data:image/png;base64," + base64.b64encode(png).decode("ascii")
            })
        except Exception as e:
            log("erro no /render-one:\n" + traceback.format_exc())
            self._send(500, {"error": str(e)})


def main():
    # Pré-carrega na subida pra falhar cedo e deixar pronto pro primeiro request.
    load_yolo()
    get_ocr(_state["default_engine"])
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"detector ouvindo em http://{HOST}:{PORT}  (yolo={_state['yolo'] is not None}, ocr_default={_state['default_engine']})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
