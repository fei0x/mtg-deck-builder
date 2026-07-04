"""Deck importers: parse pasted text / JSON into card entries, auto-detecting
the format, decoding the §4b Archidekt round-trip metadata, and resolving names
against Scryfall. No Flask imports.

Parsed result shape (consumed by app/api/io.py):
    {
      "cards":   [card_entry, ...],   # Schema A entries (deck_model.new_card_entry)
      "warnings": [str, ...],         # unresolved names / parse notes
      "format":   "plain_text" | "mtga" | "archidekt" | "json_internal",
      "deck":     deck dict | None,   # only for json_internal (full deck)
    }

Round-trip decode (§4b):
  - `zz:state=<value>`   -> inclusionState (stripped from tags)
  - `zz:primary=<value>` -> primaryTag (stripped from tags)
  - remaining `#categories` -> tags; if no zz:primary, first category is primary
  - absent zz:state -> default inclusion state (caller-supplied, default Undecided)

Tags read off `#Category` annotations are mapped back to canonical kebab keys
via tagger (display name "Card Draw" -> "card-draw"); zz:primary already carries
the kebab key.
"""
import json
import re
from typing import Any, Dict, List, Optional, Tuple

from . import deck_model, scryfall, tagger

_QTY_RE = re.compile(r"^\s*(\d+)\s*[xX]?\s+(.*)$")
# A trailing "(SET)" or "[SET]" set-code suffix on the name portion.
_SET_RE = re.compile(r"\s*[\(\[]([A-Za-z0-9]{2,6})[\)\]]\s*(?:\d+\s*)?$")

_MTGA_SECTION_RE = re.compile(r"^\s*(Deck|Commander|Sideboard|Companion|Maybeboard)\s*$",
                              re.IGNORECASE)

# Reverse of tagger.TAG_DISPLAY: display name (lower) -> canonical kebab key.
_DISPLAY_TO_KEY = {v.lower(): k for k, v in tagger.TAG_DISPLAY.items()}


def _category_to_tag(cat: str) -> str:
    """Map an Archidekt `#Category` string back to a canonical kebab tag."""
    cat = cat.strip()
    low = cat.lower()
    if low in _DISPLAY_TO_KEY:
        return _DISPLAY_TO_KEY[low]
    # Try Archidekt alias / slugify fallback (same path the builder uses).
    return tagger.canonical_from_archidekt(cat) or tagger._slugify(cat) or "other"


# --------------------------------------------------------------------------- #
# Line parsing
# --------------------------------------------------------------------------- #
def _split_tags(rest: str) -> Tuple[str, List[str]]:
    """Split the part after the qty into (name_segment, raw_tag_strings).

    Tags begin at the first ` #`. Everything before is the name (+ optional set
    code). Each `#...` runs until the next ` #` — so multi-word tags like
    `#Card Draw` stay intact.
    """
    idx = rest.find("#")
    if idx == -1:
        return rest.strip(), []
    name_part = rest[:idx].strip()
    tag_blob = rest[idx:]
    # Split on '#', drop the empty leading element.
    raw = [t.strip() for t in tag_blob.split("#") if t.strip()]
    return name_part, raw


def _strip_set_code(name_part: str) -> Tuple[str, Optional[str]]:
    m = _SET_RE.search(name_part)
    if not m:
        return name_part.strip(), None
    code = m.group(1).upper()
    name = name_part[:m.start()].strip()
    return name, code


def _parse_line(line: str) -> Optional[Dict[str, Any]]:
    """Parse one card line into a raw dict (pre-Scryfall-resolution):
        {name, quantity, editionCode, tags[], state?, primary?}
    Returns None for blank lines or `// comments`.
    """
    s = line.strip()
    if not s or s.startswith("//"):
        return None
    if _MTGA_SECTION_RE.match(s):
        return None

    m = _QTY_RE.match(s)
    if m:
        qty = int(m.group(1))
        rest = m.group(2)
    else:
        qty = 1
        rest = s

    name_part, raw_tags = _split_tags(rest)
    name, code = _strip_set_code(name_part)
    if not name:
        return None

    tags: List[str] = []
    state: Optional[str] = None
    primary: Optional[str] = None
    for raw in raw_tags:
        low = raw.lower()
        if low.startswith("zz:state="):
            state = raw.split("=", 1)[1].strip()
        elif low.startswith("zz:primary="):
            primary = raw.split("=", 1)[1].strip()
        else:
            tags.append(_category_to_tag(raw))

    return {
        "name": name,
        "quantity": qty,
        "editionCode": code,
        "tags": tags,
        "state": state,
        "primary": primary,
    }


# --------------------------------------------------------------------------- #
# Format detection
# --------------------------------------------------------------------------- #
def detect_format(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            json.loads(stripped)
            return "json_internal"
        except ValueError:
            pass
    if re.search(r"^\s*(Deck|Commander)\s*$", stripped, re.MULTILINE | re.IGNORECASE):
        return "mtga"
    if "#" in stripped:
        return "archidekt"
    return "plain_text"


# --------------------------------------------------------------------------- #
# Name resolution + entry building
# --------------------------------------------------------------------------- #
def _resolve(parsed: List[Dict[str, Any]], default_state: str,
             warnings: List[str], derive_tags: bool) -> List[Dict[str, Any]]:
    """Resolve names via Scryfall (bulk) and build Schema A card entries.

    Unresolved names are added to `warnings` and skipped (never silently
    dropped — they surface in the warnings list).
    """
    names = [p["name"] for p in parsed]
    norms: Dict[str, Dict[str, Any]] = {}
    if names:
        result = scryfall.collection(names)
        for raw in result["found"]:
            n = scryfall.normalize_card(raw)
            norms[n["name"].lower()] = n
        for missing in result["not_found"]:
            warnings.append(f"Card not found on Scryfall: {missing!r}")

    entries: List[Dict[str, Any]] = []
    next_idx = 1
    for p in parsed:
        norm = norms.get(p["name"].lower())
        if norm is None:
            # Already warned via not_found; but collection matches case-insensitively
            # by canonical name, so a fuzzy single lookup catches near-misses.
            single = scryfall.named(p["name"])
            if single is None:
                if f"Card not found on Scryfall: {p['name']!r}" not in warnings:
                    warnings.append(f"Card not found on Scryfall: {p['name']!r}")
                continue
            norm = scryfall.normalize_card(single)

        name = norm["name"]

        # Tags: prefer parsed tags; else derive from the resolved card.
        tags = list(p["tags"])
        if not tags and derive_tags:
            _, tags = tagger.derive(norm)
        if not tags:
            tags = ["other"]

        # Primary: explicit zz:primary wins; else first tag (§4b decode rule).
        primary = p["primary"]
        if primary:
            if primary not in tags:
                tags.insert(0, primary)
        else:
            primary = tags[0]

        # State: explicit zz:state wins; else the caller default.
        state = p["state"] if p["state"] in deck_model.INCLUSION_STATES else default_state

        is_commander = (primary == "commander") or (tags == ["commander"])

        entry = deck_model.new_card_entry(
            name,
            primary_tag=primary,
            tags=tags,
            inclusion_state=state,
            is_commander=is_commander,
            scryfall_id=norm["id"],
            card_id=f"c-{next_idx:04d}",
        )
        # Fill bucketing scalars + per-format legalities + price (same as the
        # builder/add-card path) so imported cards bucket/sort/gate correctly.
        deck_model.enrich_entry(entry, norm)
        entry["quantity"] = p["quantity"]
        entry["editionCode"] = p["editionCode"] or norm.get("set")
        entries.append(entry)
        next_idx += 1

    return entries


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def parse(text: str, fmt: Optional[str] = None,
          default_state: str = "undecided",
          resolve: bool = True) -> Dict[str, Any]:
    """Parse import text. Auto-detects format unless `fmt` is given.

    Returns {cards, warnings, format, deck}. `deck` is non-None only for
    json_internal. When `resolve` is False, names are not looked up on Scryfall
    (cards carry no scryfallId/price) — useful for unit tests / previews.
    """
    warnings: List[str] = []
    fmt = fmt or detect_format(text)

    if fmt == "json_internal":
        return _parse_json(text, warnings)

    parsed_lines: List[Dict[str, Any]] = []
    for line in text.splitlines():
        p = _parse_line(line)
        if p is not None:
            parsed_lines.append(p)

    if resolve:
        cards = _resolve(parsed_lines, default_state, warnings, derive_tags=True)
    else:
        cards = _raw_entries(parsed_lines, default_state)

    return {"cards": cards, "warnings": warnings, "format": fmt, "deck": None}


def _raw_entries(parsed: List[Dict[str, Any]], default_state: str) -> List[Dict[str, Any]]:
    """Build entries without Scryfall resolution (tags as parsed, no enrichment)."""
    entries = []
    for i, p in enumerate(parsed, start=1):
        tags = list(p["tags"]) or ["other"]
        primary = p["primary"] or tags[0]
        if primary not in tags:
            tags.insert(0, primary)
        state = p["state"] if p["state"] in deck_model.INCLUSION_STATES else default_state
        entry = deck_model.new_card_entry(
            p["name"], primary_tag=primary, tags=tags,
            inclusion_state=state,
            is_commander=(primary == "commander"),
            card_id=f"c-{i:04d}",
        )
        entry["quantity"] = p["quantity"]
        entry["editionCode"] = p["editionCode"]
        entries.append(entry)
    return entries


def _parse_json(text: str, warnings: List[str]) -> Dict[str, Any]:
    """Internal JSON: accept a full deck (Schema A) or a bare cards array."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        return {"cards": [], "warnings": [f"Invalid JSON: {exc}"],
                "format": "json_internal", "deck": None}

    if isinstance(data, dict) and "cards" in data:
        deck = deck_model.validate(data)
        return {"cards": list(deck.get("cards", [])), "warnings": warnings,
                "format": "json_internal", "deck": deck}
    if isinstance(data, list):
        return {"cards": data, "warnings": warnings,
                "format": "json_internal", "deck": None}

    warnings.append("JSON did not contain a deck or cards array.")
    return {"cards": [], "warnings": warnings, "format": "json_internal", "deck": None}
