"""
pipeline — Disney Comics Transcription & Semantic Vision Package.
"""

import sys
import os

# Windows OpenMP / PyTorch DLL precedence: import torch before paddle/cv2 to avoid WinError 127
try:
    import torch
except Exception:
    pass

from .config import CURRENT_PIPELINE_VERSION, SEARCH_DB_PATH

__version__ = "2.0.0"
__all__ = ["CURRENT_PIPELINE_VERSION", "SEARCH_DB_PATH"]
