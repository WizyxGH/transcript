"""
server/languages.py — Inducks languagecode -> PaddleOCR recogniser model.

Inducks publishes ~78 language codes; PaddleOCR ships recognisers for a subset of
scripts. Anything outside that subset falls back to latin, which is right for
European languages and wrong for CJK — better to fall back deliberately and
record that we did, than to silently return Chinese glyphs for a French page
(observed: fr_DBG_18 read as 美/川/河 on an illustration).

The mapping is script-based, not language-based: German, French, Turkish and
Vietnamese all read correctly with the latin recogniser, so they share one model.
"""

# Inducks languagecode -> PaddleOCR recogniser model name.
# Built from inducks_languagename joined to its script. Codes not listed fall back
# to latin, which is correct for every Latin-script language.
LANGUAGE_MODELS = {
    # ── Latin script ────────────────────────────────────────────────────────
    "af": "latin_PP-OCRv5_mobile_rec",   # Afrikaans
    "sq": "latin_PP-OCRv5_mobile_rec",   # Albanian
    "ca": "latin_PP-OCRv5_mobile_rec",   # Catalan
    "es": "latin_PP-OCRv5_mobile_rec",
    "es-ar": "latin_PP-OCRv5_mobile_rec",
    "es-cl": "latin_PP-OCRv5_mobile_rec",
    "es-co": "latin_PP-OCRv5_mobile_rec",
    "es-mx": "latin_PP-OCRv5_mobile_rec",
    "eo": "latin_PP-OCRv5_mobile_rec",   # Esperanto
    "et": "latin_PP-OCRv5_mobile_rec",   # Estonian
    "fo": "latin_PP-OCRv5_mobile_rec",   # Faroese
    "fr": "latin_PP-OCRv5_mobile_rec",
    "fr-be": "latin_PP-OCRv5_mobile_rec",
    "fr-ca": "latin_PP-OCRv5_mobile_rec",
    "fy": "latin_PP-OCRv5_mobile_rec",   # Frisian
    "ga": "latin_PP-OCRv5_mobile_rec",   # Irish
    "gd": "latin_PP-OCRv5_mobile_rec",   # Gaelic
    "hr": "latin_PP-OCRv5_mobile_rec",   # Croatian
    "hu": "latin_PP-OCRv5_mobile_rec",   # Hungarian
    "id": "latin_PP-OCRv5_mobile_rec",   # Indonesian
    "is": "latin_PP-OCRv5_mobile_rec",   # Icelandic
    "it": "latin_PP-OCRv5_mobile_rec",
    "la": "latin_PP-OCRv5_mobile_rec",   # Latin
    "la-la": "latin_PP-OCRv5_mobile_rec",
    "lb": "latin_PP-OCRv5_mobile_rec",   # Letzeburgesch
    "ltz": "latin_PP-OCRv5_mobile_rec",   # Luxembourgish
    "lv": "latin_PP-OCRv5_mobile_rec",   # Latvian
    "mk": "latin_PP-OCRv5_mobile_rec",   # Macedonian
    "mt": "latin_PP-OCRv5_mobile_rec",   # Maltese
    "nb": "latin_PP-OCRv5_mobile_rec",
    "nl": "latin_PP-OCRv5_mobile_rec",
    "nl-be": "latin_PP-OCRv5_mobile_rec",
    "nn": "latin_PP-OCRv5_mobile_rec",   # Norwegian nynorsk
    "no": "latin_PP-OCRv5_mobile_rec",
    "pl": "latin_PP-OCRv5_mobile_rec",   # Polish
    "pt": "latin_PP-OCRv5_mobile_rec",
    "pt-br": "latin_PP-OCRv5_mobile_rec",
    "ro": "latin_PP-OCRv5_mobile_rec",   # Romanian
    "sk": "latin_PP-OCRv5_mobile_rec",   # Slovak
    "sl": "latin_PP-OCRv5_mobile_rec",   # Slovenian
    "sqi": "latin_PP-OCRv5_mobile_rec",
    "sr-latn": "latin_PP-OCRv5_mobile_rec",
    "sv": "latin_PP-OCRv5_mobile_rec",   # Swedish
    "sw": "latin_PP-OCRv5_mobile_rec",   # Swahili
    "tr": "latin_PP-OCRv5_mobile_rec",   # Turkish
    "vi": "latin_PP-OCRv5_mobile_rec",   # Vietnamese
    "nso": "latin_PP-OCRv5_mobile_rec",
    "tso": "latin_PP-OCRv5_mobile_rec",
    "ve": "latin_PP-OCRv5_mobile_rec",
    "en": "latin_PP-OCRv5_mobile_rec",   # English

    # Sami languages are Latin script but Finnish/Swedish-adjacent; latin reads them.
    "se-sma": "latin_PP-OCRv5_mobile_rec",
    "se-sme": "latin_PP-OCRv5_mobile_rec",
    "se-smj": "latin_PP-OCRv5_mobile_rec",
    "se-smn": "latin_PP-OCRv5_mobile_rec",
    "se-sms": "latin_PP-OCRv5_mobile_rec",
    "fit": "latin_PP-OCRv5_mobile_rec",
    "nde": "latin_PP-OCRv5_mobile_rec",   # Low German
    "lim": "latin_PP-OCRv5_mobile_rec",   # Limburgian

    # ── Cyrillic ───────────────────────────────────────────────────────────
    "be": "cyrillic_PP-OCRv5_mobile_rec",
    "bg": "cyrillic_PP-OCRv5_mobile_rec",
    "kk": "cyrillic_PP-OCRv5_mobile_rec",
    "mn": "cyrillic_PP-OCRv5_mobile_rec",
    "ru": "cyrillic_PP-OCRv5_mobile_rec",
    "ru-lv": "cyrillic_PP-OCRv5_mobile_rec",
    "sr-cyrl": "cyrillic_PP-OCRv5_mobile_rec",
    "uk": "cyrillic_PP-OCRv5_mobile_rec",

    # ── Greek ──────────────────────────────────────────────────────────────
    "el": "el_PP-OCRv5_mobile_rec",

    # ── Arabic script ──────────────────────────────────────────────────────
    "ar": "arabic_PP-OCRv5_mobile_rec",
    "fa": "arabic_PP-OCRv5_mobile_rec",
    "ur": "arabic_PP-OCRv5_mobile_rec",

    # ── Hebrew ─────────────────────────────────────────────────────────────
    # No v5 Hebrew recogniser ships with PaddleOCR; latin is the closest
    # available and the confidence score will be poor, which keeps these pages
    # out of the index rather than polluting it.
    "he": "latin_PP-OCRv5_mobile_rec",

    # ── Devanagari & Indic ─────────────────────────────────────────────────
    "hi": "devanagari_PP-OCRv5_mobile_rec",
    "mr": "devanagari_PP-OCRv5_mobile_rec",
    "ne": "devanagari_PP-OCRv5_mobile_rec",

    # ── Other scripts ──────────────────────────────────────────────────────
    "ta": "ta_PP-OCRv5_mobile_rec",       # Tamil
    "te": "te_PP-OCRv5_mobile_rec",       # Telugu
    "th": "th_PP-OCRv5_mobile_rec",       # Thai
    "ko": "korean_PP-OCRv5_mobile_rec",   # Korean

    # ── CJK: no v5 recogniser available ────────────────────────────────────
    # PaddleOCR 3.5 ships japan/chinese only on PP-OCRv3. They still work and are
    # wired up here: without them the recogniser falls back to latin and returns
    # Chinese glyphs for a Japanese page — the exact failure seen on fr_DBG_18.
    "ja": "japan_PP-OCRv3_mobile_rec",
    "zh-hans": "ch_PP-OCRv3_mobile_rec",
    "zh-hant": "chinese_cht_PP-OCRv3_mobile_rec",
}

DEFAULT_MODEL = "latin_PP-OCRv5_mobile_rec"

# Languages whose script PaddleOCR cannot read. Their pages will score low and
# fall below the confidence floor, which is the intended behaviour: they are kept
# out of the index instead of being filled with the wrong script's characters.
KNOWN_UNSUPPORTED = {
    "as", "bn", "bn-bd", "bn-in", "gu", "kn", "ml", "tl",
}


def model_for(languagecode):
    """PaddleOCR recogniser model for an Inducks languagecode.

    Unknown or unsupported codes fall back to the latin recogniser, which is the
    right default for the large majority of Inducks publications.
    """
    if not languagecode:
        return DEFAULT_MODEL
    return LANGUAGE_MODELS.get(languagecode.strip().lower(), DEFAULT_MODEL)


def is_supported(languagecode):
    return bool(languagecode) and languagecode.strip().lower() not in KNOWN_UNSUPPORTED


if __name__ == "__main__":
    import json
    print(json.dumps({
        "mapped": len(LANGUAGE_MODELS),
        "default": DEFAULT_MODEL,
        "unsupported": sorted(KNOWN_UNSUPPORTED),
    }, indent=1))