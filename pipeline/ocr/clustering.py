"""
pipeline.ocr.clustering — Regroupement des lignes de texte OCR en bulles de lecture cohérentes.
Ordonne les bulles selon le sens de lecture standard de bande dessinée (haut en bas, gauche à droite).
"""

from typing import List, Dict, Any

ROW_FRACTION = 0.08  # Fraction de la hauteur pour regrouper par bande de lecture


def cluster_text_lines_into_bubbles(lines: List[Dict[str, Any]], row_fraction: float = ROW_FRACTION) -> List[Dict[str, Any]]:
    """
    Regroupe des lignes de texte détectées spatialement proches en bulles / blocs de lecture cohérents.
    Chaque bulle contient :
    - bbox: [x1, y1, x2, y2] englobant
    - text: texte assemblé des lignes ordonnées verticalement
    - confidence: moyenne pondérée des confiances OCR
    - lines: liste des lignes brutes
    - bottom_center: (x, y) du bas de la bulle (point d'ancrage vers le locuteur)
    """
    if not lines:
        return []

    # Trier d'abord par position verticale grossière
    sorted_lines = sorted(lines, key=lambda b: (b.get("y0", b.get("bbox", [0, 0, 0, 0])[1]),
                                                b.get("x0", b.get("bbox", [0, 0, 0, 0])[0])))
    groups = []

    for b in sorted_lines:
        if "bbox" in b:
            bx0, by0, bx1, by1 = b["bbox"]
        else:
            bx0, by0, bx1, by1 = b["x0"], b["y0"], b["x1"], b["y1"]

        placed = False
        for g in groups:
            h_overlap = max(0, min(bx1, g["x1"]) - max(bx0, g["x0"]))
            min_w = max(1.0, min(bx1 - bx0, g["x1"] - g["x0"]))
            v_gap = by0 - g["y1"]

            # Si le chevauchement horizontal est supérieur à 30% et le saut vertical est raisonnable (-10 à 35 px)
            if (h_overlap / min_w) > 0.30 and -10 <= v_gap <= 35:
                g["lines"].append(b)
                g["x0"] = min(g["x0"], bx0)
                g["x1"] = max(g["x1"], bx1)
                g["y0"] = min(g["y0"], by0)
                g["y1"] = max(g["y1"], by1)
                placed = True
                break

        if not placed:
            groups.append({
                "lines": [b],
                "x0": bx0, "y0": by0,
                "x1": bx1, "y1": by1
            })

    # Trier les lignes au sein de chaque bulle de haut en bas et fusionner le texte
    bubbles = []
    for g in groups:
        g["lines"].sort(key=lambda l: l.get("y0", l.get("bbox", [0, 0, 0, 0])[1]))
        full_text = " ".join(l["text"] for l in g["lines"] if l.get("text"))
        confs = [l.get("confidence", 0.9) for l in g["lines"]]
        mean_conf = sum(confs) / len(confs) if confs else 0.0

        bubbles.append({
            "bbox": [g["x0"], g["y0"], g["x1"], g["y1"]],
            "text": full_text,
            "confidence": mean_conf,
            "lines": g["lines"],
            "bottom_center": ((g["x0"] + g["x1"]) / 2, g["y1"]),
            "y0": g["y0"],
            "y1": g["y1"],
            "x0": g["x0"]
        })

    # Trier l'ensemble des bulles dans l'ordre de lecture BD (bande par bande, gauche à droite)
    if bubbles:
        max_h = max(b["y1"] for b in bubbles)
        row_h = max(max_h * row_fraction, 1.0)
        bubbles.sort(key=lambda b: (round(((b["y0"] + b["y1"]) / 2) / row_h), b["x0"]))

    return bubbles
