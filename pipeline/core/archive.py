"""
pipeline.core.archive — Extraction performante des tomes de BD (CBZ, CBR, ZIP, RAR).
"""

import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import List

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def find_unrar() -> str:
    """Trouve l'exécutable UnRAR sous Windows ou Linux."""
    return shutil.which("unrar") or shutil.which("UnRAR") or "unrar"


def extract_archive(archive_path: Path, dest_dir: Path) -> List[Path]:
    """
    Extrait toutes les planches d'un fichier CBZ/CBR dans un dossier temporaire.
    Retourne la liste des chemins des images extraites, triées dans l'ordre naturel des pages.
    """
    archive_path = Path(archive_path)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = archive_path.suffix.lower()

    if ext in (".cbz", ".zip"):
        with zipfile.ZipFile(archive_path) as z:
            names = [
                n for n in z.namelist()
                if not n.endswith("/") and not n.startswith("__MACOSX")
            ]
            img_names = [n for n in names if Path(n).suffix.lower() in IMAGE_EXTENSIONS]
            img_names.sort()

            extracted = []
            for name in img_names:
                out_path = dest_dir / Path(name).name
                with z.open(name) as src, open(out_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                extracted.append(out_path)
            return extracted

    elif ext in (".cbr", ".rar"):
        unrar = find_unrar()
        if not unrar or not shutil.which(unrar):
            raise RuntimeError(f"UnRAR introuvable sur le système pour extraire {archive_path.name}")

        subprocess.run(
            [unrar, "e", "-o+", "-idq", str(archive_path)],
            cwd=str(dest_dir),
            check=True
        )
        imgs = [p for p in dest_dir.iterdir() if p.suffix.lower() in IMAGE_EXTENSIONS]
        imgs.sort(key=lambda p: p.name)
        return imgs

    return []
