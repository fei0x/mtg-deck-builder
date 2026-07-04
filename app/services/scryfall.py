"""Scryfall API client + card normalizer.

All access to api.scryfall.com goes through here. Calls are serialized and
rate-limited (>=100ms apart) with a descriptive User-Agent, per Scryfall's
request guidelines. Raw card data is cached by id; the normalizer reduces a raw
Scryfall card to the camelCase shape the rest of the app consumes.
"""
import threading
import time
from typing import Any, Dict, List, Optional

import requests

from . import cache

BASE = "https://api.scryfall.com"
_HEADERS = {
    "User-Agent": "CommanderDeckBuilder/0.1 (local personal app)",
    "Accept": "application/json",
}
_MIN_INTERVAL = 0.1  # seconds between calls (Scryfall asks for 50-100ms)
_lock = threading.Lock()
_last_call = 0.0


def _get(url: str, params: Optional[dict] = None) -> requests.Response:
    """Rate-limited GET, serialized across threads."""
    global _last_call
    with _lock:
        wait = _MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        try:
            resp = requests.get(url, params=params, headers=_HEADERS, timeout=20)
        finally:
            _last_call = time.time()
    return resp


def _post(url: str, json_body: dict) -> requests.Response:
    """Rate-limited POST, serialized across threads."""
    global _last_call
    with _lock:
        wait = _MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        try:
            resp = requests.post(url, json=json_body, headers=_HEADERS, timeout=30)
        finally:
            _last_call = time.time()
    return resp


def collection(names: List[str]) -> Dict[str, Any]:
    """Bulk-fetch raw cards by name via POST /cards/collection (max 75/request).

    Returns {"found": [raw_card, ...], "not_found": [name, ...]}. Each found card
    is cached by id so later /api/cards/<id> calls hit the cache. Used by the
    EDHREC build to enrich a ~200-card pool in ~3 requests instead of ~200.
    """
    found: List[Dict[str, Any]] = []
    not_found: List[str] = []
    for i in range(0, len(names), 75):
        batch = names[i:i + 75]
        resp = _post(f"{BASE}/cards/collection",
                     {"identifiers": [{"name": n} for n in batch]})
        if resp.status_code != 200:
            not_found.extend(batch)
            continue
        data = resp.json()
        for c in data.get("data", []):
            if c.get("id"):
                cache.set("card", c["id"], c)
            found.append(c)
        for ident in data.get("not_found", []):
            if isinstance(ident, dict) and ident.get("name"):
                not_found.append(ident["name"])
    return {"found": found, "not_found": not_found}


# --------------------------------------------------------------------------- #
# Raw fetchers
# --------------------------------------------------------------------------- #
def autocomplete(q: str) -> List[str]:
    if not q or len(q) < 2:
        return []
    resp = _get(f"{BASE}/cards/autocomplete", {"q": q})
    if resp.status_code != 200:
        return []
    return resp.json().get("data", [])


def named(name: str, fuzzy: bool = True) -> Optional[Dict[str, Any]]:
    """Fetch one card by name. Returns raw card dict or None if not found."""
    key = "fuzzy" if fuzzy else "exact"
    resp = _get(f"{BASE}/cards/named", {key: name})
    if resp.status_code != 200:
        return None
    card = resp.json()
    if card.get("id"):
        cache.set("card", card["id"], card)
    return card


def by_id(scryfall_id: str) -> Optional[Dict[str, Any]]:
    cached = cache.get("card", scryfall_id)
    if cached is not None:
        return cached
    resp = _get(f"{BASE}/cards/{scryfall_id}")
    if resp.status_code != 200:
        return None
    card = resp.json()
    cache.set("card", scryfall_id, card)
    return card


def search(q: str, order: str = "name", unique: Optional[str] = None,
           max_pages: int = 1, include_extras: bool = False) -> List[Dict[str, Any]]:
    """Scryfall syntax search. Returns raw cards (first ``max_pages`` pages).

    ``include_extras=True`` includes tokens/emblems/etc. (Scryfall omits them by
    default) — needed so token printing lists aren't empty.
    """
    # `v2|` prefix invalidates pre-R7 cache entries — some were poisoned with empty
    # results from transient/rate-limited fetches (e.g. Ghalta showed 0 printings).
    cache_key = f"v2|{q}|{order}|{unique}|{max_pages}|{include_extras}"
    cached = cache.get("search", cache_key)
    if cached is not None:
        return cached

    params = {"q": q, "order": order}
    if unique:
        params["unique"] = unique
    if include_extras:
        params["include_extras"] = "true"
    cards: List[Dict[str, Any]] = []
    ok = True
    url = f"{BASE}/cards/search"
    pages = 0
    while url and pages < max_pages:
        resp = _get(url, params if pages == 0 else None)
        if resp.status_code != 200:
            ok = resp.status_code == 404  # 404 = genuinely no matches; other codes = transient
            break
        data = resp.json()
        cards.extend(data.get("data", []))
        url = data.get("next_page") if data.get("has_more") else None
        pages += 1

    # Only cache a NON-EMPTY result, or a definitive 404 (0 matches). Never cache an
    # empty list from a transient error / rate-limit — that would poison the card
    # permanently until the TTL. An empty transient result is re-fetched next time.
    if cards or ok:
        cache.set("search", cache_key, cards)
    return cards


def _printing_name_matches(card: Dict[str, Any], name: str) -> bool:
    """Is `card` actually a printing of the card named `name` (not just a card that
    *contains* that name as a secondary face/sub-spell)?

    Scryfall's `!"X"` matches face names too, so searching "Rampant Growth" also
    returns e.g. "Studious First-Year // Rampant Growth" (a `prepare` card whose
    FRONT is the creature). Accept a printing only when its full name equals X, or
    — for a single-named entry — its FRONT face name equals X (so legit DFC /
    reversible printings like "Birds of Paradise // Birds of Paradise" still match).
    """
    nl = (name or "").strip().lower()
    if (card.get("name") or "").strip().lower() == nl:
        return True
    if "//" in name:  # a DFC entry must match the full name exactly
        return False
    faces = card.get("card_faces") or []
    front = (faces[0].get("name") if faces else card.get("name")) or ""
    return front.strip().lower() == nl


TOKEN_LAYOUTS = {"token", "double_faced_token", "emblem"}


def printings(name: str, want: str = "cards") -> List[Dict[str, Any]]:
    """All printings of a card name, newest first.

    Fetches with `include_extras=True` so token/emblem printings CAN be found
    (Scryfall hides them by default). Some cards (e.g. Fanatic of Rhonas's
    Eternalize ability) create a token that shares the source card's EXACT
    name, and that token is a different game object entirely — different type
    line, oracle text, and legality — from the real card. The two must never
    mix in either direction:
      - want="cards" (default): real, non-token printings only — for the
        drawer's skin picker on an actual deck card.
      - want="tokens": token/emblem layouts only — for resolving a token/
        marker card by name (build.py `_resolve_token_card`) and for the
        Tokens panel's own skin picker on a token entity.
      - want="any": no layout split (rarely needed).

    Also filters out (a) **art-series** cards (`layout=art_series` — no real
    types/oracle/legalities, would corrupt the entry) and (b) cards that only
    contain the name as a secondary face/sub-spell (e.g. a `prepare` creature).
    NB the token-layout check is intentionally narrow — marker tokens like
    "The Monarch" have `type_line="Card"` yet ARE legitimate tokens, so
    want="tokens" must not drop on that.
    """
    cards = search(f'!"{name}"', order="released", unique="prints", max_pages=3,
                   include_extras=True)
    filtered = [c for c in cards
                if c.get("layout") != "art_series" and _printing_name_matches(c, name)]
    if want == "tokens":
        return [c for c in filtered if c.get("layout") in TOKEN_LAYOUTS]
    if want == "any":
        return filtered
    return [c for c in filtered if c.get("layout") not in TOKEN_LAYOUTS]


def rulings(scryfall_id: str) -> List[Dict[str, Any]]:
    cached = cache.get("rulings", scryfall_id)
    if cached is not None:
        return cached
    resp = _get(f"{BASE}/cards/{scryfall_id}/rulings")
    data = resp.json().get("data", []) if resp.status_code == 200 else []
    cache.set("rulings", scryfall_id, data)
    return data


# --------------------------------------------------------------------------- #
# Normalizer  -- the canonical app-facing card shape (camelCase).
# Downstream (04 build, 07 gallery, 09 drawer) depends on these keys.
# --------------------------------------------------------------------------- #
def normalize_card(card: Dict[str, Any]) -> Dict[str, Any]:
    faces = card.get("card_faces") or []

    # Images: top-level image_uris, else fall back to the faces (DFCs).
    front_imgs: Dict[str, Any] = card.get("image_uris") or {}
    back_imgs: Dict[str, Any] = {}
    if not front_imgs and faces:
        front_imgs = faces[0].get("image_uris") or {}
        if len(faces) > 1:
            back_imgs = faces[1].get("image_uris") or {}

    # Text/cost: DFCs often carry these per-face.
    oracle_text = card.get("oracle_text")
    mana_cost = card.get("mana_cost")
    if oracle_text is None and faces:
        oracle_text = "\n//\n".join(f.get("oracle_text", "") for f in faces)
    if not mana_cost and faces:
        mana_cost = " // ".join(f.get("mana_cost", "") for f in faces if f.get("mana_cost"))

    prices = card.get("prices") or {}
    purchase = card.get("purchase_uris") or {}

    # Per-face data for multi-part cards (transform, MDFC, split, adventure,
    # room, meld, etc.) — the drawer renders one type bubble + image per face.
    face_list = []
    for f in faces:
        fi = f.get("image_uris") or {}
        face_list.append({
            "name": f.get("name"),
            "typeLine": f.get("type_line"),
            "manaCost": f.get("mana_cost"),
            "oracleText": f.get("oracle_text"),
            "power": f.get("power"),
            "toughness": f.get("toughness"),
            "loyalty": f.get("loyalty"),
            "image": {"normal": fi.get("normal"), "large": fi.get("large")},
        })

    return {
        "id": card.get("id"),
        "name": card.get("name"),
        "faces": face_list,
        "manaCost": mana_cost,
        "cmc": card.get("cmc"),
        "typeLine": card.get("type_line") or (faces[0].get("type_line") if faces else None),
        "oracleText": oracle_text,
        "colors": card.get("colors") or (faces[0].get("colors") if faces else []),
        "colorIdentity": card.get("color_identity", []),
        "keywords": card.get("keywords", []),
        "power": card.get("power"),
        "toughness": card.get("toughness"),
        "loyalty": card.get("loyalty"),
        "set": card.get("set"),
        "setName": card.get("set_name"),
        "collectorNumber": card.get("collector_number"),
        "rarity": card.get("rarity"),
        "legalities": card.get("legalities", {}),
        "edhrecRank": card.get("edhrec_rank"),
        "layout": card.get("layout"),
        "image": {
            "small": front_imgs.get("small"),
            "normal": front_imgs.get("normal"),
            "large": front_imgs.get("large"),
            "back": back_imgs.get("normal") if back_imgs else None,
            "backLarge": back_imgs.get("large") if back_imgs else None,
        },
        "prices": {
            "usd": prices.get("usd"),
            "eur": prices.get("eur"),
            "tix": prices.get("tix"),
        },
        "purchaseUris": {
            "tcgplayer": purchase.get("tcgplayer"),
            "cardmarket": purchase.get("cardmarket"),
        },
        "scryfallUri": card.get("scryfall_uri"),
    }
