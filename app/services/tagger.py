"""Functional card tagging.

Produces the functional tags used by the app's Tag-mode bucketing. Strategy
(decided 2026-06-23):
  1. Use Archidekt's `defaultCategory` when present (authoritative, crowd-sourced).
  2. Fill gaps / add secondary tags via oracle-text heuristics.
  3. Fall back to a type-based tag ('lands' or 'other') if nothing matches.

The canonical tag vocabulary (kebab keys + display names) is a CONTRACT consumed
by the frontend (07 bucketing, 08 filters, 11 stats). Heuristics are intentionally
simple and tunable — users can override a card's primaryTag in the UI.
"""
import re
from typing import Any, Dict, List, Optional, Tuple

# Canonical tag -> display name.
TAG_DISPLAY: Dict[str, str] = {
    "ramp": "Ramp",
    "card-draw": "Card Draw",
    "removal": "Removal",
    "board-wipe": "Board Wipes",
    "counterspell": "Counterspells",
    "plus-one-counters": "+1/+1 Counters",
    "burn": "Burn",
    "life-gain": "Life Gain",
    "free-cast": "Free Casts",
    "pump": "Pump",
    "anthem": "Anthem",
    "group-hug": "Group Hug",
    "tokens": "Tokens",
    "tutor": "Tutors",
    "recursion": "Recursion",
    "protection": "Protection",
    "lands": "Lands",
    "other": "Other",
}

# Human-facing reference: description + how the heuristic detects each tag.
# Surfaced via GET /api/tags and the in-app Tag Reference panel (see plan/08).
# EXPAND ME — see plan/TODO.md ("Tags").
TAG_INFO: Dict[str, Dict[str, str]] = {
    "ramp": {
        "description": "Accelerates your mana development.",
        "heuristic": "Nonland cards that add mana (mana rocks/dorks: 'add {', '{T}: Add') or search your "
                     "library for a land onto the battlefield. Seeded by Archidekt's 'Ramp' category.",
    },
    "card-draw": {
        "description": "Refills your hand or digs for cards.",
        "heuristic": "Oracle text matching 'draw a/one/two/.../N cards'. Seeded by Archidekt's 'Draw' category.",
    },
    "removal": {
        "description": "Answers a single threat.",
        "heuristic": "'destroy/exile target', damage to a target creature, or 'target creature gets -X/-X'. "
                     "Seeded by Archidekt's 'Removal' category (broad — Archidekt also lumps counters here).",
    },
    "board-wipe": {
        "description": "Mass removal that hits many permanents at once.",
        "heuristic": "'destroy all', 'exile all', 'all creatures get -X/-X', or 'each creature ... destroy/sacrifice'.",
    },
    "counterspell": {
        "description": "Stops spells on the stack.",
        "heuristic": "Oracle text contains 'counter target'.",
    },
    "plus-one-counters": {
        "description": "Cares about +1/+1 counters.",
        "heuristic": "Oracle text contains '+1/+1 counter'.",
    },
    "burn": {
        "description": "Direct damage to players or any target.",
        "heuristic": "'deals N damage to any target / target player / each opponent / target player or planeswalker'.",
    },
    "life-gain": {
        "description": "Gains you life.",
        "heuristic": "'gain' followed shortly by 'life' (e.g. 'gain 3 life', 'gain that much life', "
                     "'gain life'), or the lifelink keyword.",
    },
    "free-cast": {
        "description": "Casts spells without paying their mana cost (free value / cheating spells out).",
        "heuristic": "Oracle text contains 'without paying' + 'mana cost' (e.g. cast a spell free, impulse "
                     "value, cascade-like). Seeded by Archidekt's 'Free Spells'/'Cheat' category.",
    },
    "pump": {
        "description": "Buffs a single creature's power/toughness.",
        "heuristic": "Oracle text matching 'gets +N/+N' (e.g. an Aura/Equipment/combat trick). Seeded by "
                     "Archidekt's 'Pump'/'Buff' category.",
    },
    "anthem": {
        "description": "Buffs your whole team.",
        "heuristic": "'creatures you control get +N/+N'. Seeded by Archidekt's 'Anthem' category.",
    },
    "group-hug": {
        "description": "Gives your opponents beneficial resources (draw / mana / tokens).",
        "heuristic": "Mentions other players/opponents receiving a benefit (draw/add/tokens) with no harmful "
                     "context. Conservative — prefers misses to false positives.",
    },
    "tokens": {
        "description": "Creates token creatures or other tokens.",
        "heuristic": "Oracle text contains both 'create' and 'token'.",
    },
    "tutor": {
        "description": "Searches your library for a specific card.",
        "heuristic": "'search your library for a card' / 'search your library for any'.",
    },
    "recursion": {
        "description": "Returns cards from the graveyard.",
        "heuristic": "Returns something 'from your graveyard' to your hand or the battlefield.",
    },
    "protection": {
        "description": "Protects your permanents or you.",
        "heuristic": "Keywords ward/hexproof/shroud/indestructible, 'protection from', or 'prevent all'.",
    },
    "lands": {
        "description": "Land cards.",
        "heuristic": "Type line contains 'Land'.",
    },
    "other": {
        "description": "No functional role detected.",
        "heuristic": "Fallback when nothing else matches and the card is not a land.",
    },
}


# Archidekt defaultCategory (lowercased) -> our canonical tag.
ARCHIDEKT_ALIAS: Dict[str, str] = {
    "ramp": "ramp",
    "draw": "card-draw",
    "card draw": "card-draw",
    "removal": "removal",
    "board wipe": "board-wipe",
    "board wipes": "board-wipe",
    "wipes": "board-wipe",
    "counterspell": "counterspell",
    "counterspells": "counterspell",
    "counters": "plus-one-counters",
    "protection": "protection",
    "tutor": "tutor",
    "tutors": "tutor",
    "tokens": "tokens",
    "lands": "lands",
    "land": "lands",
    "lifegain": "life-gain",
    "life gain": "life-gain",
    "burn": "burn",
    "recursion": "recursion",
    "pump": "pump",
    "buff": "pump",
    "anthem": "anthem",
    "anthems": "anthem",
    "group hug": "group-hug",
    "grouphug": "group-hug",
    "free spells": "free-cast",
    "free cast": "free-cast",
    "free casts": "free-cast",
    "cheat": "free-cast",
}

# Priority order for choosing a primary tag from heuristic matches.
_PRIORITY = [
    "lands", "ramp", "board-wipe", "removal", "counterspell", "card-draw",
    "tutor", "free-cast", "burn", "life-gain", "plus-one-counters", "anthem", "pump",
    "tokens", "recursion", "protection", "group-hug",
]


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def canonical_from_archidekt(cat: Optional[str]) -> Optional[str]:
    if not cat:
        return None
    return ARCHIDEKT_ALIAS.get(cat.strip().lower(), _slugify(cat))


def heuristic_tags(card: Dict[str, Any]) -> List[str]:
    """Functional tags inferred from oracle text + type line, in priority order."""
    text = (card.get("oracleText") or "").lower()
    type_line = (card.get("typeLine") or "").lower()
    keywords = {k.lower() for k in (card.get("keywords") or [])}
    is_land = "land" in type_line

    found: set = set()

    if is_land:
        found.add("lands")

    # Ramp: produces mana (nonland), or fetches a land onto the battlefield.
    # NB the fetch test must be pronoun/verb agnostic — cards say "search YOUR",
    # "searches THEIR", "search his or her" library — so match on the
    # search+library+land+battlefield combo rather than a fixed phrase.
    if not is_land and (
        "add {" in text
        or "{t}: add" in text
        or re.search(r"add (one|two|three|four|five|\{)", text)
        or ("search" in text and "library" in text and "land" in text and "battlefield" in text)
    ):
        found.add("ramp")

    if "search your library for a card" in text or "search your library for any" in text:
        found.add("tutor")

    if re.search(r"draw (a|one|two|three|four|x|\d+) cards?", text) or "draw cards" in text:
        found.add("card-draw")

    # Board wipe before single-target removal (both contain 'destroy').
    if ("destroy all" in text or "exile all" in text or "destroy each" in text
            or re.search(r"all creatures get [+-]\d", text)
            or ("each creature" in text and ("destroy" in text or "sacrifice" in text))):
        found.add("board-wipe")

    # Removal: single-target destroy/exile — incl. "destroy/exile UP TO N target …"
    # (Aerial Extortionist: "exile up to one target nonland permanent"; Loran:
    # "destroy up to one target artifact or enchantment"). Board-wipe checked first.
    if (re.search(r"\b(destroy|exile)\b(?:\s+up to \w+)?\s+target\b", text)
            or re.search(r"deals? \d+ damage to target creature", text)
            or re.search(r"target creature gets -\d", text)):
        found.add("removal")

    if "counter target" in text:
        found.add("counterspell")

    if "+1/+1 counter" in text:
        found.add("plus-one-counters")

    if (re.search(r"deals? \d+ damage to (any target|target player|each opponent|target player or planeswalker)", text)
            or "damage to any target" in text):
        found.add("burn")

    # Life gain: 'gain' shortly followed by 'life' (covers 'gain 3 life',
    # 'gain that much life', 'you gain life'), or the lifelink keyword. The
    # bounded gap avoids matching across sentences / unrelated 'gain ... life'.
    if (re.search(r"\bgains?\b[^.\n]{0,30}\blife\b", text) or "gain life" in text
            or "lifelink" in keywords or "lifelink" in text):  # granted lifelink counts too
        found.add("life-gain")

    # Pump (single creature) vs Anthem (whole team). Singular 'gets +N/+N' is a
    # one-creature buff (Aura/Equipment/trick); 'creatures you control get +N/+N'
    # is a team anthem.
    if re.search(r"creatures you control get \+\d+/\+\d+", text):
        found.add("anthem")
    if re.search(r"\bgets \+\d+/\+\d+", text):
        found.add("pump")

    # Free casts: cast/play a spell without paying its mana cost (impulse value,
    # cheating spells out, cascade-likes). e.g. Cosmic Cube.
    if "without paying" in text and "mana cost" in text:
        found.add("free-cast")

    if "create" in text and "token" in text:
        found.add("tokens")

    # Group Hug (best-effort, conservative — prefer misses to false positives):
    # your card hands opponents / other players a BENEFICIAL resource (draw / mana
    # / tokens / life), with no harmful context in the same text.
    gh_target = any(p in text for p in
                    ("each player", "each opponent", "another player", "each other player",
                     "target opponent", "opponents draw", "each of your opponents"))
    gh_benefit = (re.search(r"\bdraws?\b", text) or ("create" in text and "token" in text)
                  or re.search(r"\badds?\b", text))
    gh_harm = any(w in text for w in
                  ("poison", "lose", "loses", "sacrifice", "discard", "damage", "mill",
                   "destroy", "exile", "-1/-1", "loses the game"))
    if gh_target and gh_benefit and not gh_harm:
        found.add("group-hug")

    if ("return" in text and "from your graveyard" in text
            and ("to the battlefield" in text or "to your hand" in text)):
        found.add("recursion")

    if (keywords & {"ward", "hexproof", "shroud", "indestructible"}
            or "protection from" in text or "prevent all" in text
            or "totem armor" in text or "umbra armor" in text  # Umbras / totem armor protect a creature
            or re.search(r"\b(has|gains?) (ward|hexproof|shroud|indestructible)\b", text)):
        found.add("protection")

    return [t for t in _PRIORITY if t in found]


def derive(card: Dict[str, Any], archidekt_category: Optional[str] = None) -> Tuple[str, List[str]]:
    """Return (primaryTag, tags[]) for a normalized card.

    Archidekt's category (if any) leads; heuristics add the rest; type-based
    fallback ensures every card has at least one tag.
    """
    tags: List[str] = []

    arch = canonical_from_archidekt(archidekt_category)
    if arch:
        tags.append(arch)

    for t in heuristic_tags(card):
        if t not in tags:
            tags.append(t)

    if not tags:
        type_line = (card.get("typeLine") or "").lower()
        tags.append("lands" if "land" in type_line else "other")

    return tags[0], tags


def tag_catalog() -> List[Dict[str, str]]:
    """The full tag reference: key, display name, description, heuristic.

    Powers GET /api/tags and the in-app Tag Reference panel.
    """
    return [
        {
            "key": key,
            "display": TAG_DISPLAY.get(key, key),
            "description": info["description"],
            "heuristic": info["heuristic"],
        }
        for key, info in TAG_INFO.items()
    ]
