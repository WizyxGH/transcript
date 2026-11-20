"""
pipeline.core.memory — Surveillance de la mémoire RAM disponible pour éviter tout plantage OOM.
"""

import sys
import time

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


def get_available_memory_mb() -> float:
    """Retourne la mémoire RAM disponible en Mo."""
    if HAS_PSUTIL:
        return psutil.virtual_memory().available / (1024 * 1024)
    return 2048.0  # Estimation conservatrice par défaut si psutil n'est pas installé


def wait_for_memory(min_mb: float = 800.0, max_wait_sec: float = 60.0) -> bool:
    """Attend jusqu'à ce que la mémoire RAM disponible dépasse le seuil minimal."""
    start = time.time()
    while get_available_memory_mb() < min_mb:
        if (time.time() - start) > max_wait_sec:
            return False
        time.sleep(2.0)
    return True
