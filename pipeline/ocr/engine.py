"""
pipeline.ocr.engine — Moteur d'OCR PaddleOCR avec gestion robuste des flags OpenMP.
"""

import os
from typing import List, Dict, Any, Tuple
from pathlib import Path
from PIL import Image

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

try:
    import paddle
    paddle.device.set_device("cpu")
    from paddleocr import PaddleOCR
    HAS_PADDLE = True
except Exception:
    HAS_PADDLE = False
    PaddleOCR = None

_OCR_INSTANCES: Dict[str, Any] = {}


def get_ocr_engine(lang: str = "it") -> Any:
    """Retourne une instance singleton de PaddleOCR pour la langue demandée."""
    if not HAS_PADDLE:
        return None
    if lang not in _OCR_INSTANCES:
        _OCR_INSTANCES[lang] = PaddleOCR(
            use_angle_cls=False,
            lang=lang,
            show_log=False,
            enable_mkldnn=False,
        )
    return _OCR_INSTANCES[lang]


def ocr_page_image(image_path: Path, lang: str = "it") -> List[Dict[str, Any]]:
    """
    Exécute PaddleOCR sur une image et retourne les lignes détectées :
    Chaque ligne contient :
    - bbox: [x1, y1, x2, y2]
    - text: str
    - confidence: float
    """
    engine = get_ocr_engine(lang)
    if not engine:
        return []

    try:
        results = engine.ocr(str(image_path), cls=False)
        lines = []
        if not results or not results[0]:
            return []

        for line in results[0]:
            points, (txt, conf) = line
            xs = [pt[0] for pt in points]
            ys = [pt[1] for pt in points]
            lines.append({
                "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
                "text": str(txt).strip(),
                "confidence": float(conf),
                "x0": int(min(xs)),
                "y0": int(min(ys)),
                "x1": int(max(xs)),
                "y1": int(max(ys)),
            })
        return lines
    except Exception as e:
        print(f"[ocr.engine] Erreur OCR sur {image_path}: {e}")
        return []
