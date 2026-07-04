"""Local file cache for fetched external data (Scryfall / EDHREC).

Stores JSON blobs under ``cache/<namespace>/<key>.json``. Entries older than the
TTL are treated as misses and refetched. Keys are sanitized into safe filenames;
opaque keys (e.g. search queries) get a hash suffix so they stay unique.
"""
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Optional

from .. import config


def _safe_key(key: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "_", key)
    if cleaned != key or len(cleaned) > 100:
        h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
        cleaned = f"{cleaned[:80]}_{h}"
    return cleaned


def _path(namespace: str, key: str) -> Path:
    return config.CACHE_DIR / namespace / f"{_safe_key(key)}.json"


def get(namespace: str, key: str, ttl: Optional[int] = config.CACHE_TTL_SECONDS) -> Optional[Any]:
    """Return the cached value, or None if missing/expired/corrupt."""
    p = _path(namespace, key)
    if not p.exists():
        return None
    if ttl is not None and (time.time() - p.stat().st_mtime) > ttl:
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def set(namespace: str, key: str, value: Any) -> None:
    """Persist a JSON-serializable value to the cache."""
    p = _path(namespace, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
