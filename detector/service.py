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
OCR_ENGINE = os.environ.get("OCR_ENGINE", "tesseract").lower()
OCR_LANG = os.environ.get("OCR_LANG", "eng")
YOLO_CONF = float(os.environ.get("YOLO_CONF", "0.15"))

# Estado global dos modelos (carregados sob demanda, uma única vez).
_state = {
    "yolo": None,
    "yolo_error": None,
    "ocr": None,
    "ocr_error": None,
    "ocr_engine": OCR_ENGINE,
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


def load_ocr():
    if _state["ocr"] is not None or _state["ocr_error"] is not None:
        return _state["ocr"]
    engine = _state["ocr_engine"]
    try:
        if engine == "manga-ocr":
            from manga_ocr import MangaOcr
            log("carregando manga-ocr (japonês)...")
            _state["ocr"] = MangaOcr()
            log("manga-ocr pronto.")
        elif engine == "tesseract":
            import pytesseract  # noqa: F401
            # Acha o binário mesmo fora do PATH (ex.: install padrão do Windows).
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
            pytesseract.get_tesseract_version()  # valida que o binário responde
            _state["ocr"] = "tesseract"
            log(f"tesseract pronto (lang={OCR_LANG}, bin={pytesseract.pytesseract.tesseract_cmd}).")
        else:
            _state["ocr"] = None  # detecção sem OCR (só posiciona caixas)
    except Exception as e:
        _state["ocr_error"] = str(e)
        log(f"OCR '{engine}' indisponível: {e} (segue só com detecção)")
    return _state["ocr"]


def ocr_crop(pil_image):
    """Roda OCR num recorte de balão. Retorna texto limpo (ou '')."""
    engine = _state["ocr_engine"]
    ocr = _state["ocr"]
    if ocr is None:
        return ""
    try:
        if engine == "manga-ocr":
            return (ocr(pil_image) or "").strip()
        if engine == "tesseract":
            import pytesseract
            text = pytesseract.image_to_string(pil_image, lang=OCR_LANG)
            return " ".join(text.split()).strip()
    except Exception as e:
        log(f"OCR falhou num recorte: {e}")
    return ""


def detect(image_path):
    from PIL import Image

    yolo = load_yolo()
    if yolo is None:
        raise RuntimeError(_state["yolo_error"] or "YOLO não carregou")
    load_ocr()

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
            text = ocr_crop(crop)
            lines.append({
                "originalText": text,
                "confidence": round(conf * 100),
                "x": max(0.0, min(1.0, x1 / W)),
                "y": max(0.0, min(1.0, y1 / H)),
                "width": max(0.02, min(1.0, (x2 - x1) / W)),
                "height": max(0.02, min(1.0, (y2 - y1) / H)),
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
    win_fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    for name in ("arialbd.ttf", "comicbd.ttf", "ariblk.ttf", "arial.ttf"):
        cand = os.path.join(win_fonts, name)
        if os.path.exists(cand):
            return cand
    return None  # PIL cai na fonte default


def soft_wrap(text, font, max_width):
    """Quebra por palavras inteiras (nao corta palavra)."""
    words = str(text).split()
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


def fit_text(draw, text, font_path, box_w, box_h, max_size=48):
    """Encolhe a fonte ate o texto (palavras inteiras) caber no balao;
    so corta palavra como ultimo recurso (fonte minima)."""
    from PIL import ImageFont
    size = max(8, min(int(box_h * 0.95), max_size))
    while size >= 8:
        font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        lines = soft_wrap(text, font, box_w)
        wrapped = "\n".join(lines)
        bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=2)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if _max_line_width(lines, font) <= box_w and th <= box_h:
            return font, wrapped, tw, th
        if not font_path:
            break
        size -= 1
    font = ImageFont.truetype(font_path, 8) if font_path else ImageFont.load_default()
    lines = _hard_break(soft_wrap(text, font, box_w), font, box_w)
    wrapped = "\n".join(lines)
    bbox = draw.multiline_textbbox((0, 0), wrapped, font=font, align="center", spacing=2)
    return font, wrapped, bbox[2] - bbox[0], bbox[3] - bbox[1]


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


def render_image(image_path, boxes, font_path):
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

    # 1) inpaint do texto original (apenas boxes cobertos e com traducao)
    full_mask = np.zeros(img.shape[:2], dtype=np.uint8)
    has_mask = False
    for box in boxes:
        if not str(box.get("translatedText", "")).strip():
            continue
        if box.get("coverOriginal") is False:
            continue
        x1, y1, x2, y2 = px(box)
        if x2 <= x1 or y2 <= y1:
            continue
        crop = img[y1:y2, x1:x2]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)
        full_mask[y1:y2, x1:x2] = mask
        has_mask = True
    if has_mask:
        img = cv2.inpaint(img, full_mask, 5, cv2.INPAINT_NS)

    # 2) typeset da traducao
    out = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(out)
    rendered = 0
    for box in boxes:
        text = str(box.get("translatedText", "")).strip()
        if not text:
            continue
        x1, y1, x2, y2 = px(box)
        # Encaixa o texto na AREA BRANCA real do balao (a caixa do YOLO costuma
        # ser mais larga que o balao). Sem area branca clara -> recua 14%.
        inner = bubble_inner_rect(img[y1:y2, x1:x2]) if box.get("coverOriginal") is not False else None
        if inner:
            ix, iy, iw, ih = inner
            m = max(2, int(min(iw, ih) * 0.08))
            bx1, by1 = x1 + ix + m, y1 + iy + m
            bw, bh = iw - 2 * m, ih - 2 * m
        else:
            inset_x = int((x2 - x1) * 0.14)
            inset_y = int((y2 - y1) * 0.14)
            bx1, by1 = x1 + inset_x, y1 + inset_y
            bw, bh = (x2 - x1) - 2 * inset_x, (y2 - y1) - 2 * inset_y
        if bw < 8 or bh < 8:
            continue
        font, wrapped, tw, th = fit_text(draw, text, font_path, bw, bh, max_size=max(28, int(H * 0.05)))
        tx = bx1 + (bw - tw) / 2
        ty = by1 + (bh - th) / 2
        sw = max(1, getattr(font, "size", 12) // 18)
        draw.multiline_text((tx, ty), wrapped, font=font, fill="black",
                            align="center", spacing=2, stroke_width=sw, stroke_fill="white")
        rendered += 1

    return out, rendered


def render_page(image_path, boxes, out_path, font_path):
    out, rendered = render_image(image_path, boxes, font_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out.save(out_path)
    return rendered


def render_png_bytes(image_path, boxes, font_path):
    import io
    out, rendered = render_image(image_path, boxes, font_path)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue(), rendered


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
            self._send(200, {
                "ok": True,
                "yolo": _state["yolo"] is not None,
                "yoloError": _state["yolo_error"],
                "ocrEngine": _state["ocr_engine"],
                "ocrReady": _state["ocr"] is not None,
                "ocrError": _state["ocr_error"],
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
            if "ocr" in body and body["ocr"]:
                _state["ocr_engine"] = str(body["ocr"]).lower()
            if not image_path or not os.path.exists(image_path):
                self._send(400, {"error": f"imagem não encontrada: {image_path}"})
                return
            lines = detect(image_path)
            self._send(200, {
                "ok": True,
                "provider": f"yolo+{_state['ocr_engine'] if _state['ocr'] else 'no-ocr'}",
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
            for page in pages:
                image_path = page.get("imagePath", "")
                if not image_path or not os.path.exists(image_path):
                    continue
                out_name = page.get("outName") or (os.path.splitext(os.path.basename(image_path))[0] + ".png")
                out_path = os.path.join(output_dir, out_name)
                total_boxes += render_page(image_path, page.get("boxes", []), out_path, font_path)
                written.append(out_path)
            cbz_out = pack_cbz(written, cbz_path) if (cbz_path and written) else None
            self._send(200, {
                "ok": True,
                "pages": len(written),
                "boxesRendered": total_boxes,
                "outputDir": output_dir,
                "cbz": cbz_out,
                "font": font_path,
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
            png, rendered = render_png_bytes(image_path, body.get("boxes", []), body.get("font") or find_font())
            self._send(200, {
                "ok": True,
                "boxesRendered": rendered,
                "dataUrl": "data:image/png;base64," + base64.b64encode(png).decode("ascii")
            })
        except Exception as e:
            log("erro no /render-one:\n" + traceback.format_exc())
            self._send(500, {"error": str(e)})


def main():
    # Pré-carrega na subida pra falhar cedo e deixar pronto pro primeiro request.
    load_yolo()
    load_ocr()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"detector ouvindo em http://{HOST}:{PORT}  (yolo={_state['yolo'] is not None}, ocr={_state['ocr_engine'] if _state['ocr'] else 'none'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
