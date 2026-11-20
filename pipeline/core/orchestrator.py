"""
pipeline.core.orchestrator — Orchestrateur unifié pour la transcription et l'analyse visuelle.
Traite une planche complète en combinant :
- Découpage géométrique des cases (PanelExtractor)
- Reconnaissance optique de texte (PaddleOCR)
- Regroupement des lignes en bulles (Clustering)
- Détection et identification des personnages (YOLOv8 + Embeddings Inducks)
- Attribution des locuteurs et typologie narrative (Speaker Attribution)
"""

import json
import time
from pathlib import Path
from typing import Dict, Any, Optional
from PIL import Image

from pipeline.config import CURRENT_PIPELINE_VERSION
from pipeline.ocr.engine import ocr_page_image
from pipeline.vision.speakers import DialogueSpeakerExtractor


class PageOrchestrator:
    def __init__(self, use_vision: bool = True):
        self.use_vision = use_vision
        self.speaker_extractor = DialogueSpeakerExtractor() if use_vision else None

    def process_page(self, image_path: Path, lang: str = "it") -> Dict[str, Any]:
        """
        Traite une planche de bande dessinée complète.
        Retourne le dictionnaire prêt pour l'insertion en base search.sqlite.
        """
        t0 = time.time()
        image_path = Path(image_path)

        with Image.open(image_path) as img:
            width, height = img.size

        # Si le module vision avancé est disponible, exécuter le pipeline v2 complet
        if self.use_vision and self.speaker_extractor:
            result = self.speaker_extractor.extract_page_dialogues(image_path, lang=lang)
            structured_text = json.dumps(result, ensure_ascii=False)

            # Extraire le texte plat ordonné pour FTS5 et la confiance moyenne
            flat_texts = []
            confidences = []
            box_count = 0

            for p in result.get("panels", []):
                for elem in p.get("elements", []):
                    txt = elem.get("text", "").strip()
                    if txt:
                        speaker = elem.get("speaker")
                        prefix = f"[{speaker}] " if speaker else ""
                        flat_texts.append(f"{prefix}{txt}")
                        box_count += len(elem.get("lines", [1]))
                    if "confidence" in elem and elem["confidence"] is not None:
                        confidences.append(elem["confidence"])

            full_text = "\n".join(flat_texts)
            mean_conf = sum(confidences) / len(confidences) if confidences else 0.0
            elapsed_ms = int((time.time() - t0) * 1000)

            return {
                "text": full_text,
                "confidence": round(mean_conf, 4),
                "n_boxes": box_count,
                "engine": "paddle+vision",
                "ms": elapsed_ms,
                "width": width,
                "height": height,
                "pipeline_version": CURRENT_PIPELINE_VERSION,
                "structured_text": structured_text,
            }

        # Repli v1 (texte brut simple) si vision désactivée
        raw_lines = ocr_page_image(image_path, lang=lang)
        full_text = "\n".join(l["text"] for l in raw_lines if l.get("text"))
        confs = [l["confidence"] for l in raw_lines if "confidence" in l]
        mean_conf = sum(confs) / len(confs) if confs else 0.0
        elapsed_ms = int((time.time() - t0) * 1000)

        return {
            "text": full_text,
            "confidence": round(mean_conf, 4),
            "n_boxes": len(raw_lines),
            "engine": "paddle",
            "ms": elapsed_ms,
            "width": width,
            "height": height,
            "pipeline_version": 1,
            "structured_text": None,
        }
