"""
pipeline.vision — Visual detection, layout analysis & character recognition for Disney comics.
"""

from .panels import segment_panels_adaptive
from .characters import PageCharacterDetector
from .speakers import DialogueSpeakerExtractor, format_as_screenplay
from .inducks_fusion import MultimodalCharacterFusion

__all__ = [
    "segment_panels_adaptive",
    "PageCharacterDetector",
    "DialogueSpeakerExtractor",
    "format_as_screenplay",
    "MultimodalCharacterFusion",
]
