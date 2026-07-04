"""EDHREC recommendations client.

Fetches a commander's recommendation page JSON from json.edhrec.com and parses
it into a list of category buckets, each with its cards. Undocumented endpoint;
parsing is defensive and the real response shape is recorded in plan/02's log.
"""
import re
import threading
import time
from typing import Any, Dict, List, Optional

import requests

from . import cache

JSON_BASE = "https://json.edhrec.com/pages/commanders"
_HEADERS = {"User-Agent": "CommanderDeckBuilder/0.1 (local personal app)"}
_MIN_INTERVAL = 0.1
_lock = threading.Lock()
_last_call = 0.0


class CommanderNotFound(Exception):
    """Raised when no EDHREC page exists for any slug variant of a commander."""


def _get(url: str) -> requests.Response:
    global _last_call
    with _lock:
        wait = _MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        try:
            resp = requests.get(url, headers=_HEADERS, timeout=20)
        finally:
            _last_call = time.time()
    return resp


def commander_slug(name: str) -> str:
    """Convert a commander name to an EDHREC slug.

    'Atraxa, Praetors' Voice' -> 'atraxa-praetors-voice'
    For DFC/partner names ('A // B'), uses the front/first part.
    """
    s = name.lower().split("//")[0].strip()
    s = s.replace("'", "").replace("’", "")  # straight + curly apostrophes
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def slug_variants(name: str) -> List[str]:
    """Ordered slug candidates to try (handles subtitle/partner edge cases)."""
    variants = [commander_slug(name)]
    if "," in name:
        first = commander_slug(name.split(",")[0])
        if first and first not in variants:
            variants.append(first)
    return variants


def _normalize_tag(header: str, tag: Optional[str]) -> str:
    """Canonical kebab-case tag for a cardlist bucket."""
    if tag:
        return tag.strip().lower()
    return re.sub(r"[^a-z0-9]+", "-", (header or "").lower()).strip("-")


def _parse_cardview(cv: Dict[str, Any]) -> Dict[str, Any]:
    num = cv.get("num_decks")
    pot = cv.get("potential_decks")
    inclusion = None
    if isinstance(num, int) and isinstance(pot, int) and pot > 0:
        inclusion = round(100 * num / pot)
    return {
        "name": cv.get("name"),
        "sanitized": cv.get("sanitized") or cv.get("sanitized_wo"),
        "numDecks": num,
        "potentialDecks": pot,
        "inclusion": inclusion,
        "synergy": cv.get("synergy"),
        "label": cv.get("label"),
    }


def _extract_cardlists(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Locate the cardlists array within the (sometimes-nested) payload."""
    container = payload.get("container", {})
    json_dict = container.get("json_dict", {}) if isinstance(container, dict) else {}
    cardlists = json_dict.get("cardlists")
    if cardlists is None:
        # Fallbacks seen across EDHREC payload variants.
        cardlists = payload.get("cardlists") or json_dict.get("cardlist") or []
    return cardlists or []


def _parse_buckets(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    buckets: List[Dict[str, Any]] = []
    for cl in _extract_cardlists(data):
        header = cl.get("header") or cl.get("tag") or "Other"
        tag = _normalize_tag(header, cl.get("tag"))
        cardviews = cl.get("cardviews") or cl.get("cards") or []
        cards = [_parse_cardview(cv) for cv in cardviews if cv.get("name")]
        if cards:
            buckets.append({"header": header, "tag": tag, "cards": cards})
    return buckets


def recommendations(slug: str) -> List[Dict[str, Any]]:
    """Return buckets: [{header, tag, cards:[{name, synergy, inclusion, ...}]}].

    Raises CommanderNotFound on HTTP 404.
    """
    cached = cache.get("edhrec", slug)
    if cached is None:
        resp = _get(f"{JSON_BASE}/{slug}.json")
        if resp.status_code == 404:
            raise CommanderNotFound(slug)
        if resp.status_code != 200:
            raise RuntimeError(f"EDHREC returned {resp.status_code} for {slug}")
        cached = resp.json()
        cache.set("edhrec", slug, cached)
    return _parse_buckets(cached)


# EDHREC card pages (any card, not just commanders) share the same JSON shape.
CARD_JSON_BASE = "https://json.edhrec.com/pages/cards"


def recommendations_for_card(name: str) -> List[Dict[str, Any]]:
    """Recommendation buckets from a CARD's EDHREC page (cards it's played with).

    Raises CommanderNotFound on HTTP 404 (no page for that card)."""
    slug = commander_slug(name)
    key = "card:" + slug
    cached = cache.get("edhrec", key)
    if cached is None:
        resp = _get(f"{CARD_JSON_BASE}/{slug}.json")
        if resp.status_code == 404:
            raise CommanderNotFound(slug)
        if resp.status_code != 200:
            raise RuntimeError(f"EDHREC returned {resp.status_code} for card {slug}")
        cached = resp.json()
        cache.set("edhrec", key, cached)
    return _parse_buckets(cached)


def recommendations_for_name(name: str) -> List[Dict[str, Any]]:
    """Try slug variants for a commander name; raise CommanderNotFound if all 404."""
    last_exc: Optional[Exception] = None
    for slug in slug_variants(name):
        try:
            return recommendations(slug)
        except CommanderNotFound as exc:
            last_exc = exc
            continue
    raise last_exc or CommanderNotFound(name)
