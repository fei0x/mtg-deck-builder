"""Deck-build orchestration: commander -> EDHREC pool -> tagged workspace.

The signature workflow. Resolves the commander, pulls EDHREC's recommendation
pool, dedupes to unique cards, bulk-enriches them from Scryfall, derives
functional tags (heuristics; Archidekt category is an optional later refinement),
and returns a populated deck with everything Undecided except the commander.
"""
from typing import Any, Dict, List, Optional

from . import deck_model, edhrec, scryfall, tagger


class CommanderNotFound(Exception):
    """Commander resolved on Scryfall but has no EDHREC recommendation page."""


def _pool_from_buckets(buckets: List[Dict[str, Any]], commander_name: str) -> Dict[str, Dict[str, Any]]:
    """Dedupe EDHREC cardviews (they repeat across type/synergy buckets) to unique
    names, keeping the best synergy/inclusion seen for each."""
    pool: Dict[str, Dict[str, Any]] = {}
    for b in buckets:
        for cv in b["cards"]:
            name = cv.get("name")
            if not name or name == commander_name:
                continue
            cur = pool.get(name)
            if cur is None:
                pool[name] = {
                    "name": name,
                    "synergy": cv.get("synergy"),
                    "inclusion": cv.get("inclusion"),
                    "numDecks": cv.get("numDecks"),
                }
            else:
                if (cv.get("inclusion") or 0) > (cur.get("inclusion") or 0):
                    cur["inclusion"] = cv.get("inclusion")
                if (cv.get("synergy") or 0) > (cur.get("synergy") or 0):
                    cur["synergy"] = cv.get("synergy")
    return pool


def fetch_pool(commander_name: str) -> Dict[str, Dict[str, Any]]:
    """EDHREC recommendation pool for a commander, deduped to unique names.

    Raises edhrec.CommanderNotFound if no EDHREC page exists. Shared by the
    initial build and the 'Reload EDHREC Data' action."""
    buckets = edhrec.recommendations_for_name(commander_name)
    return _pool_from_buckets(buckets, commander_name)


def fetch_pool_for_card(card_name: str) -> Dict[str, Dict[str, Any]]:
    """EDHREC recommendation pool from a CARD's page (cards played alongside it),
    deduped to unique names. Raises edhrec.CommanderNotFound if no page exists."""
    buckets = edhrec.recommendations_for_card(card_name)
    return _pool_from_buckets(buckets, card_name)


def enrich_names(names: List[str]) -> Dict[str, Dict[str, Any]]:
    """Bulk-enrich card names -> {name_lower: normalized_card}.

    ~3 Scryfall /collection calls for ~200 names, plus a fuzzy fallback for any
    the batch missed (DFC/MDFC front-face names, punctuation variants). Keys by
    both the full name and the front-face name. Shared by build + reload-edhrec."""
    norms: Dict[str, Dict[str, Any]] = {}
    if not names:
        return norms
    enrich = scryfall.collection(list(names))
    for c in enrich["found"]:
        n = scryfall.normalize_card(c)
        norms[n["name"].lower()] = n
        front = n["name"].split("//")[0].strip().lower()
        if front and front not in norms:
            norms[front] = n
    for missing in enrich["not_found"]:
        raw = scryfall.named(missing)  # fuzzy, front-face aware
        if raw:
            n = scryfall.normalize_card(raw)
            norms[n["name"].lower()] = n
            norms[missing.lower()] = n
    return norms


def build_from_commander(commander: str, deck_name: Optional[str] = None,
                         description: str = "", fmt: str = "commander") -> Dict[str, Any]:
    # 1. Resolve commander on Scryfall (canonical name + id).
    raw = scryfall.named(commander)
    if raw is None:
        raise ValueError(f"Commander '{commander}' was not found on Scryfall.")
    cmd = scryfall.normalize_card(raw)

    # 2. EDHREC pool (raises edhrec.CommanderNotFound if no page for any slug).
    try:
        pool = fetch_pool(cmd["name"])
    except edhrec.CommanderNotFound as exc:
        raise CommanderNotFound(cmd["name"]) from exc

    # 3. Bulk-enrich the pool from Scryfall (~3 calls for ~200 cards).
    norms = enrich_names(list(pool.keys()))

    # 4. Create the deck and populate it (all Undecided; commander locked_in).
    deck = deck_model.new_deck(
        deck_name or f"{cmd['name']}",
        commander=cmd["name"],
        commander_scryfall_id=cmd["id"],
        description=description,
        fmt=fmt,
    )
    # Enrich the commander entry (created by new_deck as c-0001).
    if deck["cards"]:
        deck_model.enrich_entry(deck["cards"][0], cmd)

    idx = 2
    for name, info in pool.items():
        norm = norms.get(name.lower())
        if norm:
            primary, tags = tagger.derive(norm)  # heuristics; Archidekt cat applied lazily later
        else:
            primary, tags = "other", ["other"]
        entry = deck_model.new_card_entry(
            name,
            primary_tag=primary,
            tags=tags,
            inclusion_state="undecided",
            scryfall_id=(norm["id"] if norm else None),
            edhrec_data={
                "numDecks": info.get("numDecks"),
                "inclusion": info.get("inclusion"),
                "synergy": info.get("synergy"),
            },
            card_id=f"c-{idx:04d}",
        )
        if norm:
            deck_model.enrich_entry(entry, norm)
        deck["cards"].append(entry)
        idx += 1

    return deck
