"""Deck model: schema, defaults, validation, and derived metrics.

Model decision (2026-06-24): the 5-level **inclusion state** is the single source
of truth for what's "in the deck". This replaces Archidekt's per-category
`includedInDeck` flag + separate Maybeboard (cards not in the deck simply sit at
undecided/out/locked_out in the workspace). So decks have no `categories[]` array
and no Maybeboard; buckets are derived from card tags/type/cost at render time.

Deck count = sum(quantity) over cards whose inclusionState is locked_in or in.
"""
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 1

# Ordered most-"in" to most-"out". Order matters for inclusion-state sorting.
INCLUSION_STATES = ["locked_in", "in", "undecided", "out", "locked_out"]
IN_STATES = {"locked_in", "in"}  # what counts toward the deck

DEFAULT_SETTINGS = {
    "cmcBreakpoints": [3, 4],
    "powerBreakpoints": [],
    "toughnessBreakpoints": [],
    "showInfoStrip": True,
    "inclusionSort": True,
    "secondarySort": "name",
    "stateFilter": list(INCLUSION_STATES),
}

BUCKETING_MODES = ["tag", "type", "cost", "rarity", "pt"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slugify(text: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "deck"


def deck_id(commander_or_name: str) -> str:
    return f"{_slugify(commander_or_name)}-{uuid.uuid4().hex[:4]}"


def next_card_id(deck: Dict[str, Any]) -> str:
    nums = []
    for c in deck.get("cards", []):
        cid = c.get("id", "")
        if cid.startswith("c-") and cid[2:].isdigit():
            nums.append(int(cid[2:]))
    return f"c-{(max(nums) + 1 if nums else 1):04d}"


def new_card_entry(
    name: str,
    *,
    primary_tag: str = "other",
    tags: Optional[List[str]] = None,
    inclusion_state: str = "undecided",
    is_commander: bool = False,
    scryfall_id: Optional[str] = None,
    edhrec_data: Optional[Dict[str, Any]] = None,
    card_id: str = "c-0001",
) -> Dict[str, Any]:
    return {
        "id": card_id,
        "name": name,
        "scryfallId": scryfall_id,
        # printingId pins the exact printing/"skin" (a set code isn't unique);
        # collectorNumber drives the mtgprint export. Default to the base card.
        "printingId": scryfall_id,
        "collectorNumber": None,
        "quantity": 1,
        "inclusionState": inclusion_state,
        "isCommander": is_commander,
        "primaryTag": primary_tag,
        "tags": tags if tags is not None else [primary_tag],
        "showInAllTagBuckets": False,
        "showInAllTypeBuckets": False,
        "editionCode": None,
        # Bucketing/sorting/stats scalars (filled by enrich_entry). Kept on the
        # entry so Type/CMC/Rarity/P-T bucketing + stats work without refetching.
        "cmc": None,
        "cardType": None,
        "cardTypes": [],
        "rarity": None,
        "power": None,
        "toughness": None,
        "colorIdentity": [],
        "commanderLegal": True,
        "legalities": {},
        # Stored so the gallery can search oracle text offline (populated by
        # enrich_entry / re-evaluate). Kept short; not shown (the drawer uses cache).
        "oracleText": "",
        "edhrecData": edhrec_data or {},
        "price": {"usd": None, "eur": None, "tcgplayerUrl": None, "cardmarketUrl": None},
    }


def enrich_entry(entry: Dict[str, Any], norm: Dict[str, Any],
                 keep_price: bool = False) -> Dict[str, Any]:
    """Fill a card entry's Scryfall-derived fields from a normalized card.

    Stores the small bucketing scalars (cmc/type/rarity/power/toughness/identity)
    + edition + printing id + collector number + legalities + price. Does NOT
    store images/oracle text (those stay in cache). Used by the builder (04),
    card add/enrich (04), importers (05), printing changes + re-enrich (R5).

    `keep_price=True` preserves the entry's existing `price` (R5: the cost is
    frozen to the original printing — switching skins / re-enriching must not
    churn it). Pass False on the first enrichment so the price is captured.
    """
    entry["scryfallId"] = norm.get("id")
    entry["printingId"] = norm.get("id")
    entry["editionCode"] = norm.get("set")
    entry["collectorNumber"] = norm.get("collectorNumber")
    entry["cmc"] = norm.get("cmc")
    entry["cardTypes"] = all_types(norm.get("typeLine"))
    entry["cardType"] = entry["cardTypes"][0]
    entry["rarity"] = norm.get("rarity")
    entry["power"] = norm.get("power")
    entry["toughness"] = norm.get("toughness")
    entry["colorIdentity"] = norm.get("colorIdentity") or []
    entry["legalities"] = norm.get("legalities") or {}
    entry["commanderLegal"] = entry["legalities"].get("commander") == "legal"  # legacy convenience
    entry["oracleText"] = norm.get("oracleText") or ""  # for offline oracle-text search
    if not (keep_price and entry.get("price", {}).get("usd") is not None):
        prices = norm.get("prices") or {}
        purchase = norm.get("purchaseUris") or {}
        entry["price"] = {
            "usd": prices.get("usd"),
            "eur": prices.get("eur"),
            "tcgplayerUrl": purchase.get("tcgplayer"),
            "cardmarketUrl": purchase.get("cardmarket"),
        }
    return entry


def new_deck(name: str, commander: Optional[str] = None,
             commander_scryfall_id: Optional[str] = None,
             description: str = "", fmt: str = "commander") -> Dict[str, Any]:
    now = _now()
    deck: Dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "id": deck_id(commander or name),
        "name": name,
        "commander": commander,
        "commanderScryfallId": commander_scryfall_id,
        "description": description,
        "format": fmt,
        "created": now,
        "modified": now,
        "bucketingMode": "tag",
        "settings": dict(DEFAULT_SETTINGS),
        "cards": [],
    }
    if commander:
        deck["cards"].append(new_card_entry(
            commander,
            primary_tag="commander",
            tags=["commander"],
            inclusion_state="locked_in",
            is_commander=True,
            scryfall_id=commander_scryfall_id,
            card_id="c-0001",
        ))
    return deck


def validate(deck: Dict[str, Any]) -> Dict[str, Any]:
    """Light validation/coercion. Raises ValueError on structural problems."""
    if not isinstance(deck, dict):
        raise ValueError("deck must be an object")
    if not deck.get("name"):
        raise ValueError("deck.name is required")
    deck.setdefault("schemaVersion", SCHEMA_VERSION)
    deck.setdefault("format", "commander")
    deck.setdefault("cards", [])
    settings = {**DEFAULT_SETTINGS, **(deck.get("settings") or {})}
    deck["settings"] = settings
    if deck.get("bucketingMode") not in BUCKETING_MODES:
        deck["bucketingMode"] = "tag"
    for c in deck["cards"]:
        if c.get("inclusionState") not in INCLUSION_STATES:
            c["inclusionState"] = "undecided"
        c.setdefault("tags", [c.get("primaryTag", "other")])
        c.setdefault("quantity", 1)
    return deck


# --------------------------------------------------------------------------- #
# Derived metrics
# --------------------------------------------------------------------------- #
def entry_legal(entry: Dict[str, Any], fmt: str = "commander") -> bool:
    """Whether a card is legal for the given format. Unknown legality → legal."""
    leg = entry.get("legalities")
    if isinstance(leg, dict) and leg:
        return leg.get(fmt) == "legal"
    if "commanderLegal" in entry and fmt == "commander":
        return entry["commanderLegal"] is not False
    return True


def in_deck_count(deck: Dict[str, Any]) -> int:
    fmt = deck.get("format", "commander")
    return sum(int(c.get("quantity", 1)) for c in deck.get("cards", [])
               if c.get("inclusionState") in IN_STATES and entry_legal(c, fmt))


def total_count(deck: Dict[str, Any]) -> int:
    """All workspace cards (every state), summed by quantity."""
    return sum(int(c.get("quantity", 1)) for c in deck.get("cards", []))


def total_price(deck: Dict[str, Any]) -> float:
    total = 0.0
    fmt = deck.get("format", "commander")
    for c in deck.get("cards", []):
        if c.get("inclusionState") not in IN_STATES or not entry_legal(c, fmt):
            continue
        usd = (c.get("price") or {}).get("usd")
        try:
            total += float(usd) * int(c.get("quantity", 1))
        except (TypeError, ValueError):
            continue
    return round(total, 2)


def state_breakdown(deck: Dict[str, Any]) -> Dict[str, int]:
    counts = {s: 0 for s in INCLUSION_STATES}
    for c in deck.get("cards", []):
        st = c.get("inclusionState", "undecided")
        counts[st] = counts.get(st, 0) + 1
    return counts


_TYPE_PRIORITY = ["Creature", "Planeswalker", "Instant", "Sorcery",
                  "Artifact", "Enchantment", "Land", "Battle"]


def all_types(type_line: Optional[str]) -> list:
    """All major card types present, in priority order (front face for DFCs).

    'Artifact Creature — Golem' -> ['Creature', 'Artifact']
    'Enchantment Land' -> ['Land', 'Enchantment']  (Land/Enchantment both present)
    """
    front = (type_line or "").split("//")[0].lower()
    found = [t for t in _TYPE_PRIORITY if t.lower() in front]
    return found or ["Other"]


def primary_type(type_line: Optional[str]) -> str:
    """Primary MTG card type for Card-Type bucketing (priority order)."""
    return all_types(type_line)[0]


def summary(deck: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": deck.get("id"),
        "name": deck.get("name"),
        "commander": deck.get("commander"),
        "format": deck.get("format", "commander"),
        "inDeckCount": in_deck_count(deck),
        "totalCount": total_count(deck),
        "modified": deck.get("modified"),
    }
