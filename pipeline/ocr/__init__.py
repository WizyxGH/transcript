"""
pipeline.ocr — Text recognition & balloon clustering modules.
"""

from .clustering import cluster_text_lines_into_bubbles
from .engine import get_ocr_engine, ocr_page_image, HAS_PADDLE

__all__ = ["cluster_text_lines_into_bubbles", "get_ocr_engine", "ocr_page_image", "HAS_PADDLE"]
