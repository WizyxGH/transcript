"""
Découpeur automatique de cases (panels) pour planches de bandes dessinées Disney.
Utilise l'analyse des gouttières blanches/fond et la détection de contours rectangulaires.
"""

import os
from typing import List, Tuple
import cv2
import numpy as np
from PIL import Image


def segment_panels_adaptive(img: Image.Image) -> List[Tuple[int, int, int, int]]:
    """
    Découpe une planche de BD en cases individuelles (panels) en détectant
    les gouttières de séparation claires (papier/fond).
    Gère aussi bien les planches multi-cases que les splash pages pleine page.
    Retourne la liste des boîtes [x1, y1, x2, y2] triées dans l'ordre de lecture.
    """
    orig_w, orig_h = img.size
    analysis_w = 600
    analysis_h = int(analysis_w * orig_h / orig_w)
    thumb = img.convert("L").resize((analysis_w, analysis_h), Image.Resampling.BILINEAR)
    arr = np.array(thumb)

    # Le fond de papier des gouttières est dans les percentiles élevés (>= 80%)
    bg_thresh = max(190, int(np.percentile(arr, 85)))
    is_bg = arr >= bg_thresh

    # 1. Détection des bandes horizontales (strips)
    row_bg_ratio = is_bg[:, int(analysis_w * 0.05):int(analysis_w * 0.95)].mean(axis=1)
    strips = []
    in_strip = False
    start_y = 0

    for y in range(analysis_h):
        if row_bg_ratio[y] < 0.78:
            if not in_strip:
                in_strip = True
                start_y = y
        else:
            if in_strip:
                in_strip = False
                if (y - start_y) > 0.08 * analysis_h:
                    strips.append((start_y, y))

    if in_strip and (analysis_h - start_y) > 0.08 * analysis_h:
        strips.append((start_y, analysis_h))

    # Si aucune séparation horizontale claire n'est trouvée (ex: splash page pleine page)
    if not strips or len(strips) <= 1:
        return [(0, 0, orig_w, orig_h)]

    scale_x = orig_w / analysis_w
    scale_y = orig_h / analysis_h
    panels = []

    # 2. Découpage horizontal en cases à l'intérieur de chaque bande
    for (y1, y2) in strips:
        strip_bg = is_bg[y1:y2, :]
        col_bg_ratio = strip_bg.mean(axis=0)

        in_panel = False
        start_x = 0
        for x in range(analysis_w):
            if col_bg_ratio[x] < 0.78:
                if not in_panel:
                    in_panel = True
                    start_x = x
            else:
                if in_panel:
                    in_panel = False
                    if (x - start_x) > 0.08 * analysis_w:
                        panels.append((
                            int(start_x * scale_x),
                            int(y1 * scale_y),
                            int(x * scale_x),
                            int(y2 * scale_y)
                        ))
        if in_panel and (analysis_w - start_x) > 0.08 * analysis_w:
            panels.append((
                int(start_x * scale_x),
                int(y1 * scale_y),
                int(analysis_w * scale_x),
                int(y2 * scale_y)
            ))

    return panels if panels else [(0, 0, orig_w, orig_h)]


def extract_panels(image_path: str, min_panel_area_ratio: float = 0.02) -> List[Tuple[int, int, int, int]]:
    """
    Extrait les coordonnées [x, y, w, h] des cases d'une page de scan de BD.
    Retourne la liste des boîtes triées dans l'ordre de lecture (haut en bas, gauche à droite).
    """
    # Lecture avec PIL pour éviter les limitations de chunks OpenCV
    pil_img = Image.open(image_path).convert("RGB")
    img = np.array(pil_img)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    h_page, w_page = gray.shape
    total_area = h_page * w_page

    # Binarisation pour faire ressortir les gouttières blanches et les bordures noires
    _, thresh = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)

    # Fermeture morphologique pour fusionner le contenu intérieur de chaque case
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    # Trouver les contours extérieurs
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    panels = []
    min_area = total_area * min_panel_area_ratio
    max_area = total_area * 0.95

    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        area = w * h
        # Filtrer les bordures de page, les bandes trop fines ou les petits artefacts
        if min_area < area < max_area and w > w_page * 0.15 and h > h_page * 0.08:
            panels.append((x, y, w, h))

    # Tri dans l'ordre de lecture (par bandes horizontales d'abord, puis de gauche à droite)
    # On groupe les cases dont le Y est similaire (à 5% de la hauteur de la page près)
    def reading_order_key(box):
        x, y, w, h = box
        band = int(y / (h_page * 0.06))
        return (band, x)

    panels.sort(key=reading_order_key)
    return panels


if __name__ == "__main__":
    import sys
    test_img = sys.argv[1] if len(sys.argv) > 1 else r"c:\Users\starl\Documents\Projets\Sites\DisneyComicsHub\page3_preview.png"
    boxes = extract_panels(test_img)
    print(f"Cases détectées sur {os.path.basename(test_img)} : {len(boxes)}")
    for i, (x, y, w, h) in enumerate(boxes, start=1):
        print(f"  Case #{i:2d} : x={x:4d}, y={y:4d}, w={w:4d}, h={h:4d}")
