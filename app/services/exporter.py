"""Deck exporters: one function per format, each takes a deck + options and
returns text. No Flask imports — pure functions over the Schema A deck dict.

Default scope for every text format = **Included only** (inclusionState in
{locked_in, in}). `json_internal` is the exception: it dumps the full workspace
(every card, every state) as the on-disk Schema A.

Tag display: tags are stored as canonical kebab keys (e.g. `card-draw`). On
export to human/Archidekt formats we render them via tagger.TAG_DISPLAY
("Card Draw") so the categories read naturally and re-import cleanly. The
reserved round-trip metadata (`#zz:primary=<kebab>`) keeps the raw kebab key so
decode is exact.
"""
import json
from typing import Any, Dict, List, Optional

from . import deck_model, tagger

IN_STATES = deck_model.IN_STATES


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _included(deck: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Cards counted as in the deck (locked_in + in)."""
    return [c for c in deck.get("cards", [])
            if c.get("inclusionState") in IN_STATES]


def _scope(deck: Dict[str, Any], options: Optional[dict]) -> List[Dict[str, Any]]:
    """Which cards to export.

    Default = included only (locked_in + in). `options={"states": [...]}` (R7)
    exports exactly the listed inclusion states — lets the UI export any mix (e.g.
    just "undecided" to share an almost-in list). `scope:"all"`/`includeAll` still
    exports the whole workspace.
    """
    options = options or {}
    states = options.get("states")
    if states:
        sset = set(states)
        return [c for c in deck.get("cards", []) if c.get("inclusionState") in sset]
    if options.get("scope") == "all" or options.get("includeAll"):
        return list(deck.get("cards", []))
    return _included(deck)


def _qty(card: Dict[str, Any]) -> int:
    try:
        return max(1, int(card.get("quantity", 1)))
    except (TypeError, ValueError):
        return 1


def _tag_display(tag: str) -> str:
    return tagger.TAG_DISPLAY.get(tag, tag)


def _line(card: Dict[str, Any], *, set_code: bool = False,
          set_bracket: bool = False, collector: bool = False) -> str:
    """`<qty> <name>` with an optional set-code / collector-number suffix.

    `collector=True` (mtgprint, R5) emits `(SET) <collectorNumber>` to pin the
    exact printing/"skin" — a set code alone can't distinguish two printings in
    the same set. Falls back to the bare line when the set/number are missing.
    """
    base = f"{_qty(card)} {card.get('name')}"
    code = card.get("editionCode")
    if collector:
        num = card.get("collectorNumber")
        if code and num:
            base += f" ({code.upper()}) {num}"
        return base
    if set_code and code:
        if set_bracket:
            base += f" [{code.upper()}]"
        else:
            base += f" ({code.upper()})"
    return base


# --------------------------------------------------------------------------- #
# Plain text
# --------------------------------------------------------------------------- #
def plain_text(deck: Dict[str, Any], options: Optional[dict] = None) -> str:
    """One card per line. Options:
      - category_headers (bool): group by primaryTag with `// <Tag>` comments
      - set_codes (bool): append `(SET)`
    Scope defaults to included-only.
    """
    options = options or {}
    cards = _scope(deck, options)
    set_codes = bool(options.get("set_codes"))

    if options.get("category_headers"):
        return _grouped_plain(cards, set_codes)

    return "\n".join(_line(c, set_code=set_codes) for c in cards)


def _grouped_plain(cards: List[Dict[str, Any]], set_codes: bool) -> str:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []
    for c in cards:
        tag = c.get("primaryTag") or "other"
        if tag not in groups:
            groups[tag] = []
            order.append(tag)
        groups[tag].append(c)

    blocks: List[str] = []
    for tag in order:
        lines = [f"// {_tag_display(tag)}"]
        lines += [_line(c, set_code=set_codes) for c in groups[tag]]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


# --------------------------------------------------------------------------- #
# MTGA
# --------------------------------------------------------------------------- #
def _is_arena_legal(card: Dict[str, Any]) -> Optional[bool]:
    """Best-effort Arena legality from edhrecData/legalities if present on the
    card entry. Deck entries don't store legalities (those live in cache), so
    this usually returns None → no warning emitted. Kept for forward-compat."""
    leg = card.get("legalities")
    if isinstance(leg, dict) and "arena" in leg:
        return leg.get("arena") == "legal"
    return None


def mtga(deck: Dict[str, Any], options: Optional[dict] = None) -> str:
    """MTGA import format with `Deck` / `Commander` sections.

    Commander(s) (isCommander=True) go under `Commander`; everything else
    included goes under `Deck`. A `// WARNING:` comment is prepended if any
    included card is known to be non-Arena-legal (best-effort; deck entries
    rarely carry legalities, so this is usually silent).
    """
    options = options or {}
    cards = _scope(deck, options)
    set_codes = bool(options.get("set_codes"))

    commanders = [c for c in cards if c.get("isCommander")]
    main = [c for c in cards if not c.get("isCommander")]

    non_arena = [c.get("name") for c in cards if _is_arena_legal(c) is False]

    parts: List[str] = []
    if non_arena:
        parts.append("// WARNING: contains cards not available on MTG Arena: "
                     + ", ".join(non_arena))

    deck_lines = ["Deck"] + [_line(c, set_code=set_codes) for c in main]
    parts.append("\n".join(deck_lines))

    if commanders:
        cmd_lines = ["Commander"] + [_line(c, set_code=set_codes) for c in commanders]
        parts.append("\n".join(cmd_lines))

    return "\n\n".join(parts)


# --------------------------------------------------------------------------- #
# mtgprint.net
# --------------------------------------------------------------------------- #
def mtgprint(deck: Dict[str, Any], options: Optional[dict] = None) -> str:
    """`<qty> <name> (SET) <collectorNumber>` list of included cards (R5).

    The collector number pins the user's chosen printing/"skin"; without it
    mtgprint picks an arbitrary printing. Cards lacking a set/number fall back to
    a bare `<qty> <name>` line (mtgprint resolves a default)."""
    options = options or {}
    cards = _scope(deck, options)
    return "\n".join(_line(c, collector=True) for c in cards)


# --------------------------------------------------------------------------- #
# Archidekt (plain category annotations)
# --------------------------------------------------------------------------- #
def archidekt(deck: Dict[str, Any], options: Optional[dict] = None) -> str:
    """`<qty> <name> #Tag1 #Tag2` — real tags as Archidekt categories.

    Tags render via their display names so they read naturally in Archidekt
    (e.g. `#Card Draw`). Scope defaults to included-only.
    """
    options = options or {}
    cards = _scope(deck, options)
    set_codes = bool(options.get("set_codes"))

    lines: List[str] = []
    for c in cards:
        line = _line(c, set_code=set_codes)
        for tag in c.get("tags", []):
            line += f" #{_tag_display(tag)}"
        lines.append(line)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Archidekt lossless round-trip (§4b)
# --------------------------------------------------------------------------- #
def archidekt_roundtrip(deck: Dict[str, Any], options: Optional[dict] = None) -> str:
    """§4b lossless scheme. Each card line carries:
      - its real tags as `#<TagDisplay>` categories
      - `#zz:state=<inclusionState>`
      - `#zz:primary=<primaryTag-kebab>`

    Scope here is the **full workspace** by default (the whole point is to back
    up every card incl. undecided/out so the round-trip restores everything).
    Pass options={"scope": "included"} to limit to included cards.
    """
    options = options or {}
    if options.get("scope") == "included":
        cards = _included(deck)
    else:
        cards = list(deck.get("cards", []))
    set_codes = bool(options.get("set_codes"))

    lines: List[str] = []
    for c in cards:
        line = _line(c, set_code=set_codes)
        for tag in c.get("tags", []):
            line += f" #{_tag_display(tag)}"
        state = c.get("inclusionState", "undecided")
        primary = c.get("primaryTag") or "other"
        line += f" #zz:state={state}"
        line += f" #zz:primary={primary}"
        lines.append(line)
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# JSON internal (full Schema A)
# --------------------------------------------------------------------------- #
def json_internal(deck: Dict[str, Any], options: Optional[dict] = None) -> str:
    """Full workspace as Schema A JSON (backup / transfer). Always full deck."""
    return json.dumps(deck, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #
FORMATS = {
    "plain_text": plain_text,
    "mtga": mtga,
    "mtgprint": mtgprint,
    "archidekt": archidekt,
    "archidekt_roundtrip": archidekt_roundtrip,
    "json_internal": json_internal,
}


def export(deck: Dict[str, Any], fmt: str, options: Optional[dict] = None) -> str:
    fn = FORMATS.get(fmt)
    if fn is None:
        raise ValueError(f"Unknown export format: {fmt!r}. "
                         f"Valid: {', '.join(sorted(FORMATS))}")
    return fn(deck, options)
