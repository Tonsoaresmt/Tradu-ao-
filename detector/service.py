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
        if engine == "easyocr":
            import easyocr
            gpu = False
            try:
                import torch
                gpu = bool(torch.cuda.is_available())
            except Exception:
                gpu = False
            log(f"carregando easyocr (IA, gpu={gpu}; baixa o modelo de EN na 1a vez)...")
            reader = easyocr.Reader(["en"], gpu=gpu, verbose=False)
            _state["ocr_engines"][engine] = reader
            log("easyocr pronto.")
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


def _tesseract_text(pil_image, psm):
    import pytesseract
    import re
    text = pytesseract.image_to_string(pil_image, lang=OCR_LANG, config=f"--oem 1 --psm {psm}")
    text = re.sub(r"[|\\_~{}\[\]<>]", "", text)   # ruído comum de OCR
    return " ".join(text.split()).strip()


def ocr_crop(engine, pil_image):
    """Roda OCR num recorte de balão com o engine pedido. Retorna texto limpo (ou '')."""
    ocr = get_ocr(engine)
    if ocr is None:
        return ""
    try:
        if engine == "manga-ocr":
            return (ocr(pil_image) or "").strip()
        if engine == "easyocr":
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
            import re
            text = re.sub(r"[|\\_~{}\[\]<>]", "", " ".join(parts))
            return " ".join(text.split()).strip()
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
TARGET_FILL = 0.72       # ocupacao alvo do balao (deixa margem confortavel: 0.65-0.80)
MIN_FONT_BASE = 14       # fonte minima legivel (px); cresce com a resolucao


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


def _hard_break(lines, font, max_width):
    """Ultimo recurso: corta palavras gigantes, com hifen."""
    out = []
    for line in lines:
        while font.getbbox(line + "-")[2] > max_width and len(line) > 2:
            cut = len(line)
            while cut > 2 and font.getbbox(line[:cut] + "-")[2] > max_width:
                cut -= 1
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

    size = max(min_size, min(int(box_h * 0.85), max_size))
    while size >= min_size:
        font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        spacing = _line_spacing(size)
        lines = balanced_wrap(text, font, avail_w)
        wrapped = "\n".join(lines)
        bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=spacing)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if _max_line_width(lines, font) <= avail_w and th <= avail_h:
            return font, wrapped, tw, th, spacing
        if not font_path:
            break
        size -= 1

    font = ImageFont.truetype(font_path, min_size) if font_path else ImageFont.load_default()
    spacing = _line_spacing(min_size)
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

    size = max(min_size, min(int(box_h * 0.9), max_size))
    while size >= min_size:
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
                return font, wrapped, bbox[2] - bbox[0], bbox[3] - bbox[1], spacing
        size -= 1
    return None


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

    # 1) inpaint do texto original. CRUCIAL: limpa SO a area branca INTERNA do
    # balao, RECUADA pra dentro, pra NUNCA apagar o contorno preto do balao (o
    # anel que delimita a fala e a diferencia do cenario/narracao).
    full_mask = np.zeros(img.shape[:2], dtype=np.uint8)
    has_mask = False
    for box in boxes:
        # No typeset, so limpa balao ja traduzido; no modo fundo-do-editor
        # (typeset=False) limpa TODO balao detectado (tira o ingles de uma vez).
        if typeset and not str(box.get("translatedText", "")).strip():
            continue
        if box.get("coverOriginal") is False:
            continue
        if (box.get("type") or "fala").lower() == "sfx":
            continue  # SFX: preserva a arte original (sem inpaint)
        x1, y1, x2, y2 = px(box)
        if x2 <= x1 or y2 <= y1:
            continue
        # area branca interna do balao dentro da caixa, com recuo de seguranca
        inner = bubble_inner_rect(img[y1:y2, x1:x2])
        if inner:
            ix, iy, iw, ih = inner
            pad = max(2, int(min(iw, ih) * 0.06))   # nao encostar no anel preto
            rx1, ry1 = x1 + ix + pad, y1 + iy + pad
            rx2, ry2 = x1 + ix + iw - pad, y1 + iy + ih - pad
        else:
            pad_x, pad_y = int((x2 - x1) * 0.10), int((y2 - y1) * 0.10)
            rx1, ry1, rx2, ry2 = x1 + pad_x, y1 + pad_y, x2 - pad_x, y2 - pad_y
        if rx2 - rx1 < 4 or ry2 - ry1 < 4:
            continue
        crop = img[ry1:ry2, rx1:rx2]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        # PRESERVA a arte que INVADE o balao (rosto/cabelo do personagem, etc.):
        # so limpa componentes escuros pequenos e INTERNOS (texto). Descarta os
        # que encostam na borda da area (vem de fora) ou sao grandes (silhueta) —
        # tradução não pode apagar recurso do original.
        mh, mw = mask.shape
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        text_mask = np.zeros_like(mask)
        for i in range(1, n):
            cx, cy, cw, ch, area = stats[i]
            # So preserva BLOBS GRANDES (arte/silhueta de personagem invadindo o
            # balao). Letras sao pequenas e SEMPRE limpas — mesmo perto da borda
            # (senao sobra texto ingles no fundo). Nao usar "encosta na borda".
            too_big = (cw > mw * 0.62 or ch > mh * 0.62 or area > 0.16 * mw * mh)
            if too_big:
                continue
            text_mask[labels == i] = 255
        mask = cv2.dilate(text_mask, np.ones((3, 3), np.uint8), iterations=2)
        full_mask[ry1:ry2, rx1:rx2] = mask
        has_mask = True
    if has_mask:
        img = cv2.inpaint(img, full_mask, 5, cv2.INPAINT_NS)

    # 2) typeset da traducao
    out = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if not typeset:
        # Modo "fundo do editor": so o inpaint (ingles removido, arte/rosto
        # preservados) — o texto editavel e desenhado por cima pela UI.
        return out, 0, []
    draw = ImageDraw.Draw(out)
    rendered = 0
    issues = []
    for box in boxes:
        text = str(box.get("translatedText", "")).strip()
        if not text:
            continue
        text = text.upper()                 # lettering de scan: CAIXA ALTA
        btype = (box.get("type") or "fala").lower()
        is_sfx = btype == "sfx"
        is_bubble = btype in ("fala", "pensamento")
        x1, y1, x2, y2 = px(box)

        # Area base do balao: area branca real (ou a caixa toda como fallback).
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
            max_font, stroke_div, fill = max(30, int(H * 0.05)), 18, 0.92
        else:  # fala / pensamento
            max_font, stroke_div, fill = max(34, int(H * 0.06)), 16, 0.92
        min_font = max(MIN_FONT_BASE, int(H * 0.016))

        # 1a opcao p/ BALAO: encaixe ELIPTICO (formato oval, padrao profissional).
        method = "rect"
        res = None
        if is_bubble:
            res = fit_text_ellipse(draw, text, font_path, aw, ah,
                                   min_size=min_font, max_size=max_font, k=0.9)
            if res:
                method = "ellipse"
                fx1, fy1, fw, fh = ax1, ay1, aw, ah
        if not res:
            # Caixa retangular (narracao/grito/sfx) ou fallback do balao: recuo
            # de seguranca + encaixe retangular balanceado.
            mfrac = 0.0 if is_sfx else (0.12 if is_bubble else 0.07)
            mx, my = int(aw * mfrac), int(ah * mfrac)
            fx1, fy1, fw, fh = ax1 + mx, ay1 + my, aw - 2 * mx, ah - 2 * my
            res = fit_text(draw, text, font_path, fw, fh,
                           min_size=min_font, max_size=max_font, fill=fill)

        font, wrapped, tw, th, spacing = res
        # centraliza o bloco na area (centro visual do balao)
        tx = fx1 + (fw - tw) / 2
        ty = fy1 + (fh - th) / 2
        sw = max(1, getattr(font, "size", 14) // stroke_div)
        if is_sfx or btype == "grito":
            sw = max(2, sw)  # contorno forte pra ler sobre a arte
        draw.multiline_text((tx, ty), wrapped, font=font, fill="black",
                            align="center", spacing=spacing, stroke_width=sw, stroke_fill="white")
        rendered += 1

        # ---- QC: confere se ficou no padrao (dentro do balao, ocupacao ok) ----
        problems = []
        if tw > fw + 2 or th > fh + 2:
            problems.append("texto transborda o balao")
        if getattr(font, "size", 99) <= min_font and (tw > fw * 0.97 or th > fh * 0.97):
            problems.append("nao coube nem na fonte minima (texto longo demais)")
        if (th / float(ah) if ah else 0) < 0.20:
            problems.append("texto pequeno demais para o balao")
        if is_bubble and method == "rect":
            problems.append("nao encaixou no formato oval (caiu no retangular)")
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
            import base64
            typeset = body.get("typeset", True)
            png, rendered, issues = render_png_bytes(image_path, body.get("boxes", []), body.get("font") or find_font(), typeset=typeset)
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
