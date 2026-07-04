"""Import / export API routes (per API Contract B in plan/00).

  POST /api/decks/<id>/export   {format, options} -> {text}
  POST /api/import              {format?, text, options} -> parsed cards (+ deck)
  POST /api/import/archidekt    {url} -> new deck pulled from Archidekt
"""
import re
from typing import Any, Dict, List, Optional

import requests
from flask import Blueprint, jsonify, request

from ..services import (deck_model, deck_store, exporter, importer, scryfall,
                        tagger)

bp = Blueprint("io", __name__, url_prefix="/api")

_ARCHIDEKT_DECK_API = "https://www.archidekt.com/api/decks/{id}/?format=json"
_HEADERS = {"User-Agent": "CommanderDeckBuilder/0.1 (local personal app)",
            "Accept": "application/json"}


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
@bp.post("/decks/<deck_id>/export")
def export_deck(deck_id: str):
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    body = request.get_json(silent=True) or {}
    fmt = body.get("format")
    options = body.get("options") or {}
    if not fmt:
        return jsonify({"error": "format is required"}), 400
    try:
        text = exporter.export(deck, fmt, options)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"text": text})


# --------------------------------------------------------------------------- #
# Import (text / JSON)
# --------------------------------------------------------------------------- #
@bp.post("/import")
def import_text():
    """Parse import text and optionally merge/replace into a target deck.

    Body: {text, format?, options?}
      options:
        defaultState   inclusion state for cards lacking zz:state (default undecided)
        deckId         existing deck to apply the import to (optional)
        conflict       "merge" (append) | "replace" (clear first)  -- only with deckId
        createDeck     {name, commander?} -> build a new deck from the parsed cards
    Returns {cards, warnings, format, deck?}.
    """
    body = request.get_json(silent=True) or {}
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "text is required"}), 400

    options = body.get("options") or {}
    default_state = options.get("defaultState", "undecided")
    if default_state not in deck_model.INCLUSION_STATES:
        default_state = "undecided"

    parsed = importer.parse(text, fmt=body.get("format"),
                            default_state=default_state)

    deck_id = options.get("deckId")
    create = options.get("createDeck")

    if deck_id:
        deck = deck_store.load(deck_id)
        if deck is None:
            return jsonify({"error": "Deck not found"}), 404
        conflict = options.get("conflict", "merge")
        skip_dupes = bool(options.get("skipDuplicates"))
        before = len(deck.get("cards", []))
        deck, skipped, merged = _apply_to_deck(deck, parsed["cards"], conflict, skip_dupes)
        deck = deck_store.save(deck)
        parsed["deck"] = deck
        parsed["added"] = len(deck.get("cards", [])) - (0 if conflict == "replace" else before)
        parsed["skipped"] = skipped
        parsed["merged"] = merged
    elif create:
        deck = _new_deck_from_cards(parsed.get("deck"), parsed["cards"], create)
        deck = deck_store.save(deck)
        parsed["deck"] = deck

    return jsonify(parsed)


def _renumber(cards: List[Dict[str, Any]], start: int) -> int:
    idx = start
    for c in cards:
        c["id"] = f"c-{idx:04d}"
        idx += 1
    return idx


def _apply_to_deck(deck: Dict[str, Any], new_cards: List[Dict[str, Any]],
                   conflict: str, skip_dupes: bool = False) -> tuple:
    """Merge/replace new_cards into deck. Returns (deck, skipped, merged).

    Duplicate handling (by card name, case-insensitive) in the "merge" mode (R5):
      - `skip_dupes` True  → a name already present is **skipped** (counted).
      - `skip_dupes` False → a name already present **increments that entry's
        quantity** instead of creating a second entry with a different printing
        (counted as `merged`). In-paste duplicates collapse the same way.
    Only genuinely new names are appended (renumbered to avoid id collisions).
    """
    if conflict == "replace":
        deck["cards"] = []
    existing = deck.get("cards", [])
    by_name = {}
    for c in existing:
        by_name.setdefault(c.get("name", "").lower(), c)

    skipped = 0
    merged = 0
    to_add: List[Dict[str, Any]] = []
    for c in new_cards:
        key = c.get("name", "").lower()
        if conflict != "replace" and key in by_name:
            if skip_dupes:
                skipped += 1
            else:
                ex = by_name[key]
                ex["quantity"] = (ex.get("quantity") or 1) + (c.get("quantity") or 1)
                merged += 1
            continue
        to_add.append(c)
        by_name[key] = c  # collapse later in-paste duplicates of the same name

    # Renumber the genuinely-new cards to avoid id collisions with existing ones.
    nums = [int(c["id"][2:]) for c in existing
            if c.get("id", "").startswith("c-") and c["id"][2:].isdigit()]
    start = (max(nums) + 1) if nums else 1
    _renumber(to_add, start)
    deck["cards"] = existing + to_add
    return deck, skipped, merged


def _new_deck_from_cards(parsed_deck: Optional[Dict[str, Any]],
                         cards: List[Dict[str, Any]],
                         create: Dict[str, Any]) -> Dict[str, Any]:
    # A full internal-JSON import already carries a deck — reuse it, just rename.
    if parsed_deck is not None:
        if create.get("name"):
            parsed_deck["name"] = create["name"]
        parsed_deck["id"] = deck_model.deck_id(parsed_deck.get("commander")
                                               or parsed_deck.get("name") or "deck")
        return parsed_deck

    name = create.get("name") or "Imported Deck"
    commander = create.get("commander")
    deck = deck_model.new_deck(name, commander=commander)
    # new_deck may have seeded a commander entry; renumber imported cards after it.
    start = len(deck["cards"]) + 1
    _renumber(cards, start)
    deck["cards"].extend(cards)
    return deck


# --------------------------------------------------------------------------- #
# Archidekt URL import
# --------------------------------------------------------------------------- #
def _extract_deck_id(url: str) -> Optional[str]:
    """Pull the numeric deck id out of an Archidekt URL or bare id."""
    if not url:
        return None
    m = re.search(r"/decks/(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"(\d+)", url)  # bare id fallback
    return m.group(1) if m else None


def map_archidekt_deck(data: Dict[str, Any], *, enrich: bool = True,
                       default_state: str = "undecided") -> Dict[str, Any]:
    """Map an Archidekt deck JSON payload into a Schema A deck.

    Decodes §4b `zz:` metadata from categories when present; otherwise defaults
    state to `default_state` and primary = first real category. Enriches each
    card with Scryfall id/price/edition when `enrich` is True.
    """
    name = data.get("name") or "Archidekt Import"
    raw_cards = data.get("cards") or []

    # First pass: parse each entry into our intermediate shape.
    parsed: List[Dict[str, Any]] = []
    for rc in raw_cards:
        card = rc.get("card") or {}
        oracle = card.get("oracleCard") or {}
        cname = oracle.get("name") or card.get("name")
        if not cname:
            continue
        edition = (card.get("edition") or {}).get("editioncode")
        cats = rc.get("categories") or []

        tags: List[str] = []
        state: Optional[str] = None
        primary: Optional[str] = None
        for cat in cats:
            low = str(cat).lower()
            if low.startswith("zz:state="):
                state = str(cat).split("=", 1)[1].strip()
            elif low.startswith("zz:primary="):
                primary = str(cat).split("=", 1)[1].strip()
            else:
                tags.append(importer._category_to_tag(str(cat)))

        parsed.append({
            "name": cname,
            "quantity": rc.get("quantity", 1) or 1,
            "editionCode": edition.upper() if edition else None,
            "tags": tags,
            "state": state,
            "primary": primary,
        })

    # Bulk-enrich names via Scryfall.
    norms: Dict[str, Dict[str, Any]] = {}
    warnings: List[str] = []
    if enrich and parsed:
        result = scryfall.collection([p["name"] for p in parsed])
        for raw in result["found"]:
            n = scryfall.normalize_card(raw)
            norms[n["name"].lower()] = n
        for missing in result["not_found"]:
            warnings.append(f"Card not found on Scryfall: {missing!r}")

    commander_name: Optional[str] = None
    commander_id: Optional[str] = None
    deck = deck_model.new_deck(name)  # commander filled in after we find it

    idx = 1
    for p in parsed:
        norm = norms.get(p["name"].lower())
        tags = list(p["tags"])
        if not tags:
            tags = list(tagger.derive(norm)[1]) if norm else ["other"]
        primary = p["primary"]
        if primary:
            if primary not in tags:
                tags.insert(0, primary)
        else:
            primary = tags[0]
        state = p["state"] if p["state"] in deck_model.INCLUSION_STATES else default_state
        is_commander = (primary == "commander") or ("commander" in [c.lower() for c in tags])

        entry = deck_model.new_card_entry(
            norm["name"] if norm else p["name"],
            primary_tag=primary,
            tags=tags,
            inclusion_state=("locked_in" if is_commander else state),
            is_commander=is_commander,
            scryfall_id=(norm["id"] if norm else None),
            card_id=f"c-{idx:04d}",
        )
        entry["quantity"] = p["quantity"]
        entry["editionCode"] = p["editionCode"] or (norm.get("set") if norm else None)
        if norm:
            entry["price"] = {
                "usd": norm["prices"]["usd"], "eur": norm["prices"]["eur"],
                "tcgplayerUrl": norm["purchaseUris"]["tcgplayer"],
                "cardmarketUrl": norm["purchaseUris"]["cardmarket"],
            }
        if is_commander and commander_name is None:
            commander_name = entry["name"]
            commander_id = entry["scryfallId"]
        deck["cards"].append(entry)
        idx += 1

    if commander_name:
        deck["commander"] = commander_name
        deck["commanderScryfallId"] = commander_id
        deck["id"] = deck_model.deck_id(commander_name)

    deck["_warnings"] = warnings  # transient; stripped before save below
    return deck


@bp.post("/import/archidekt")
def import_archidekt():
    body = request.get_json(silent=True) or {}
    url = body.get("url")
    deck_num = _extract_deck_id(url or "")
    if not deck_num:
        return jsonify({"error": "Could not extract an Archidekt deck id from the URL"}), 400

    try:
        resp = requests.get(_ARCHIDEKT_DECK_API.format(id=deck_num),
                            headers=_HEADERS, timeout=20)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to reach Archidekt: {exc}"}), 502
    if resp.status_code == 404:
        return jsonify({"error": "Archidekt deck not found (private or invalid id)"}), 404
    if resp.status_code != 200:
        return jsonify({"error": f"Archidekt returned HTTP {resp.status_code}"}), 502

    options = body.get("options") or {}
    default_state = options.get("defaultState", "undecided")
    if default_state not in deck_model.INCLUSION_STATES:
        default_state = "undecided"

    deck = map_archidekt_deck(resp.json(), enrich=True, default_state=default_state)
    warnings = deck.pop("_warnings", [])
    deck = deck_store.save(deck)
    return jsonify({"deck": deck, "warnings": warnings}), 201
