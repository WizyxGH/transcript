"""
pipeline.cli — Point d'entrée en ligne de commande pour le pipeline Transcript & Vision.
Permet d'exécuter l'analyse complète d'une planche, d'un tome, ou la repasse v2.
"""

import argparse
import json
import sys
from pathlib import Path

from pipeline.config import CURRENT_PIPELINE_VERSION, SEARCH_DB_PATH
from pipeline.core.orchestrator import PageOrchestrator
from pipeline.vision.speakers import format_as_screenplay


def main():
    parser = argparse.ArgumentParser(
        description="Disney Comics Transcript & Vision CLI"
    )
    parser.add_argument(
        "--screenplay",
        type=Path,
        help="Affiche la transcription structurée en format scénario pour une image donnée.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Avec --screenplay, affiche la sortie au format JSON brut.",
    )
    parser.add_argument(
        "--lang",
        default="it",
        help="Langue pour l'OCR (it, fr, en, etc. Défaut : it).",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=SEARCH_DB_PATH,
        help="Chemin de la base search.sqlite.",
    )
    args = parser.parse_args()

    if args.screenplay:
        if not args.screenplay.exists():
            sys.exit(f"Erreur : Image introuvable : {args.screenplay}")

        orchestrator = PageOrchestrator(use_vision=True)
        res = orchestrator.process_page(args.screenplay, lang=args.lang)

        if args.json:
            print(res["structured_text"])
        else:
            if res.get("structured_text"):
                data = json.loads(res["structured_text"])
                print(format_as_screenplay(data))
            else:
                print(res["text"])
        return

    parser.print_help()


if __name__ == "__main__":
    main()
