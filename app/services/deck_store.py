"""Deck persistence: one JSON file per deck under decks/.

Filenames are the deck id (already slug + hex, filesystem-safe).
"""
import json
import os
import tempfile
from typing import Any, Dict, List, Optional

from .. import config
from . import deck_model


def _path(deck_id: str):
    return config.DECKS_DIR / f"{deck_id}.json"


def list_decks() -> List[Dict[str, Any]]:
    """Light summaries for the deck switcher. A file that fails to load is
    still listed — as a `broken` entry carrying the error — instead of just
    disappearing; the caller decides how to flag it in the UI."""
    summaries = []
    for p in sorted(config.DECKS_DIR.glob("*.json")):
        try:
            deck = json.loads(p.read_text(encoding="utf-8"))
            summaries.append(deck_model.summary(deck))
        except Exception as e:
            summaries.append({"id": p.stem, "name": p.stem, "broken": True, "error": str(e)})
    return summaries


def load(deck_id: str) -> Optional[Dict[str, Any]]:
    p = _path(deck_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def save(deck: Dict[str, Any]) -> Dict[str, Any]:
    """Validate, bump `modified`, and persist. Returns the saved deck.

    Writes to a uniquely-named temp file in decks/, then atomically renames it
    onto the target. Two overlapping saves (e.g. a burst of quick edits) can
    no longer interleave into a torn/corrupt file — the target always ends up
    as one writer's complete, valid JSON, never a half-and-half mix.
    """
    deck = deck_model.validate(deck)
    deck["modified"] = deck_model._now()
    path = _path(deck["id"])
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(deck, ensure_ascii=False, indent=2))
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return deck


def delete(deck_id: str) -> bool:
    p = _path(deck_id)
    if p.exists():
        p.unlink()
        return True
    return False


def exists(deck_id: str) -> bool:
    return _path(deck_id).exists()
