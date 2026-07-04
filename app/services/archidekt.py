"""Archidekt card-data client (read-only, undocumented endpoint).

Used to augment our functional tagging with Archidekt's crowd-sourced auto
category. `GET https://archidekt.com/api/cards/v2/?name=<name>` returns card
results whose `oracleCard.defaultCategory` is Archidekt's functional category
(e.g. Ramp / Draw / Removal). It is often null — heuristics fill the gaps.
"""
import threading
import time
from typing import Optional

import requests

from . import cache

BASE = "https://archidekt.com/api/cards/v2/"
_HEADERS = {"User-Agent": "CommanderDeckBuilder/0.1 (local personal app)", "Accept": "application/json"}
_MIN_INTERVAL = 0.15
_lock = threading.Lock()
_last_call = 0.0


def _get(params: dict) -> Optional[requests.Response]:
    global _last_call
    with _lock:
        wait = _MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        try:
            return requests.get(BASE, params=params, headers=_HEADERS, timeout=15)
        except requests.RequestException:
            return None
        finally:
            _last_call = time.time()


def default_category(name: str) -> Optional[str]:
    """Return Archidekt's functional category for a card name, or None.

    Cached permanently-ish (TTL applies). Empty string is cached to mean
    'looked up, none found' so we don't re-hit the network.
    """
    cached = cache.get("archidekt_cat", name)
    if cached is not None:
        return cached or None

    resp = _get({"name": name, "pageSize": 5})
    cat = None
    if resp is not None and resp.status_code == 200:
        results = resp.json().get("results", [])
        # Prefer an exact name match; else take the first result.
        match = next(
            (r for r in results
             if ((r.get("oracleCard") or {}).get("name", "").lower() == name.lower())),
            results[0] if results else None,
        )
        if match:
            cat = (match.get("oracleCard") or {}).get("defaultCategory")

    cache.set("archidekt_cat", name, cat or "")
    return cat or None
