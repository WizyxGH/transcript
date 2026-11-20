"""
pipeline.config — Configuration centralisée du pipeline Disney Comics Transcript & Vision.
Définit les chemins des modèles, de la base SQLite et les paramètres d'inférence.
"""

from pathlib import Path
import os
import sys

# Windows DLL directory fix for PyTorch / cuDNN (e.g. shm.dll)
if sys.platform == "win32":
    try:
        torch_lib = Path(sys.executable).parent / "Lib" / "site-packages" / "torch" / "lib"
        if torch_lib.exists():
            os.add_dll_directory(str(torch_lib))
            os.environ["PATH"] = str(torch_lib) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass

# Racine du package pipeline et du projet transcript
PIPELINE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PIPELINE_ROOT.parent

# Dossier des modèles d'IA et des embeddings
MODELS_DIR = PIPELINE_ROOT / "models"
YOLO_MODEL_PATH = MODELS_DIR / "yolov8n.pt"
EMBEDDINGS_INDEX_PATH = MODELS_DIR / "character_embeddings.npz"

# Données locales (base SQLite & caches)
DATA_DIR = Path(os.environ.get("DISNEY_DATA_DIR", PROJECT_ROOT / "data"))
SEARCH_DB_PATH = Path(os.environ.get("TRANSCRIPT_DB_PATH", DATA_DIR / "search.sqlite"))

# Version actuelle du pipeline (2 = Découpage cases + OCR bulles + attribution des locuteurs)
CURRENT_PIPELINE_VERSION = 2

# Configuration des seuils par défaut
DEFAULT_OCR_CONFIDENCE_FLOOR = 0.50
DEFAULT_CHARACTER_MATCH_THRESHOLD = 0.68
DEFAULT_ROW_FRACTION = 0.08  # Regroupement des bulles par ligne de lecture
