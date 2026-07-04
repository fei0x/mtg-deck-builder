"""Card-mutation routes for a deck (per API Contract B in plan/00).

  POST   /api/decks/<id>/cards               add a card by name
  PATCH  /api/decks/<id>/cards/<cardId>       update state/tag/quantity/edition/...
  DELETE /api/decks/<id>/cards/<cardId>       remove a card
  POST   /api/decks/<id>/cards/<cardId>/enrich  lazy Scryfall fill (null scryfallId)
"""
from flask import Blueprint, jsonify, request

from ..services import (archidekt, builder, deck_model, deck_store, edhrec,
                        scryfall, tagger)

bp = Blueprint("build", __name__, url_prefix="/api/decks")

_ALLOWED_PATCH = {
    "inclusionState", "primaryTag", "tags", "quantity",
    "showInAllTagBuckets", "showInAllTypeBuckets", "editionCode",
    "cardType", "cardTypes",
}


def _find_card(deck, card_id):
    return next((c for c in deck.get("cards", []) if c.get("id") == card_id), None)


@bp.post("/<deck_id>/cards")
def add_card(deck_id: str):
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    raw = scryfall.named(name)
    if raw is None:
        return jsonify({"error": f"'{name}' not found on Scryfall"}), 422
    norm = scryfall.normalize_card(raw)

    requested_cat = body.get("category")
    if requested_cat:
        primary, tags = tagger.canonical_from_archidekt(requested_cat), None
        tags = [primary] + [t for t in tagger.heuristic_tags(norm) if t != primary]
    else:
        primary, tags = tagger.derive(norm)

    entry = deck_model.new_card_entry(
        norm["name"], primary_tag=primary, tags=tags,
        inclusion_state="undecided", scryfall_id=norm["id"],
        card_id=deck_model.next_card_id(deck),
    )
    deck_model.enrich_entry(entry, norm)
    deck["cards"].append(entry)
    deck_store.save(deck)
    return jsonify(entry), 201


@bp.patch("/<deck_id>/cards/<card_id>")
def update_card(deck_id: str, card_id: str):
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    card = _find_card(deck, card_id)
    if card is None:
        return jsonify({"error": "Card not found"}), 404

    body = request.get_json(silent=True) or {}
    # (WS9) Inclusion is editable even on illegal cards — legality still trumps at
    # the count/stats/playtest level, but the stored state is the user's to set.
    if "inclusionState" in body and body["inclusionState"] not in deck_model.INCLUSION_STATES:
        return jsonify({"error": "invalid inclusionState"}), 400

    for key in _ALLOWED_PATCH:
        if key in body:
            card[key] = body[key]

    # Re-resolve the printing/"skin" if the user picked one. Identify by
    # printingId when given (a set code is NOT unique — e.g. two printings in
    # one set), else fall back to matching editionCode. The printing JSON must be
    # NORMALIZED (camelCase) before enriching, or typeLine is missing and the
    # card wrongly falls into the "Other" type bucket. The price is kept frozen
    # to the original printing (R5 user pref).
    pid = body.get("printingId")
    if (pid or "editionCode" in body) and card.get("scryfallId"):
        norm_p = None
        if pid:
            raw = scryfall.by_id(pid)
            norm_p = scryfall.normalize_card(raw) if raw else None
        if norm_p is None and "editionCode" in body:
            for p in scryfall.printings(card["name"]):
                if p.get("set") == body["editionCode"]:
                    norm_p = scryfall.normalize_card(p)
                    break
        if norm_p is not None:
            deck_model.enrich_entry(card, norm_p, keep_price=True)

    deck_store.save(deck)
    return jsonify(card)


@bp.post("/<deck_id>/reenrich")
def reenrich(deck_id: str):
    """Backfill/refresh every card's Scryfall-derived fields (R5).

    Re-fetches each card by its selected printing (printingId, else scryfallId,
    else by name), normalizes, and refills bucketing scalars + the full
    `legalities` map + `collectorNumber`. Preserves inclusionState/tags/quantity/
    printing selection and the FROZEN price (keep_price=True). Used to upgrade
    decks created before the legalities map existed, and on format change when a
    card lacks the map.
    """
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    updated = 0
    for c in deck.get("cards", []):
        sid = c.get("printingId") or c.get("scryfallId")
        raw = scryfall.by_id(sid) if sid else None
        # Self-heal: re-resolve by the entry's name if the stored printing isn't a
        # genuine printing of this card — i.e. a different card, an art-series card,
        # a token/emblem that merely shares the card's name (e.g. the Zombie Snake
        # Druid token Fanatic of Rhonas's Eternalize makes, itself named "Fanatic
        # of Rhonas"), or a card that only contains the name as a secondary
        # face/sub-spell (e.g. "Studious First-Year // Rampant Growth").
        # `_printing_name_matches` checks the FRONT/full name, so a legit DFC/
        # reversible printing is NOT reset.
        if raw is not None and (not scryfall._printing_name_matches(raw, c.get("name", ""))
                                or raw.get("layout") == "art_series"
                                or raw.get("layout") in scryfall.TOKEN_LAYOUTS
                                or raw.get("type_line") == "Card"):
            raw = None
        if raw is None:
            raw = scryfall.named(c["name"])
        if raw is None:
            continue
        deck_model.enrich_entry(c, scryfall.normalize_card(raw), keep_price=True)
        updated += 1
    deck_store.save(deck)
    return jsonify({"updated": updated, "deck": deck})


@bp.post("/<deck_id>/reprice")
def reprice(deck_id: str):
    """Reload card metadata (R5). Same enrichment we run at deck-build time:

    1. **Metadata** for EVERY card — batched via /cards/collection (one ~3-call
       lookup for the whole pool). Refreshes the printing-INDEPENDENT fields
       (cmc, types, color identity, P/T, legalities, oracle text) so they stay
       current and the oracle-text search works pool-wide. Deliberately does NOT
       touch the selected printing (scryfallId/printingId/editionCode/collector
       number/rarity) or the frozen price.
    2. **Cheapest price** for the INCLUDED cards (locked_in + in) — fetches each
       card's printings (also warming the skin cache) and takes the lowest USD, so
       the deck cost reflects the cheapest version rather than a random printing.
       Scoped to included cards to stay bounded (printings is one search per card).
    """
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    cards = deck.get("cards", [])

    # 1. Pool-wide metadata refresh (batched by name — printing-independent fields).
    names = sorted({c["name"] for c in cards if c.get("name")})
    norm_by_name = {}
    for low, n in builder.enrich_names(names).items():
        norm_by_name[low] = n
    for c in cards:
        norm = norm_by_name.get((c.get("name") or "").lower())
        if not norm:
            continue
        c["cmc"] = norm.get("cmc")
        c["cardTypes"] = deck_model.all_types(norm.get("typeLine"))
        c["cardType"] = c["cardTypes"][0]
        c["colorIdentity"] = norm.get("colorIdentity") or []
        c["power"] = norm.get("power")
        c["toughness"] = norm.get("toughness")
        c["legalities"] = norm.get("legalities") or {}
        c["commanderLegal"] = c["legalities"].get("commander") == "legal"
        c["oracleText"] = norm.get("oracleText") or ""

    # `meta_only` skips the per-card printings pass (used for the cheap auto-backfill
    # that powers oracle-text search — just the batched metadata above).
    if request.args.get("meta_only"):
        deck_store.save(deck)
        return jsonify({"updated": len(cards), "repriced": 0, "deck": deck})

    # 2. Cheapest price for included cards.
    in_states = {"locked_in", "in"}
    repriced = 0
    for c in cards:
        if c.get("inclusionState") not in in_states or not c.get("name"):
            continue
        prints = scryfall.printings(c["name"])  # also warms the skin cache
        cheapest, cheapest_p = None, None
        for p in prints:
            usd = (p.get("prices") or {}).get("usd")
            try:
                v = float(usd)
            except (TypeError, ValueError):
                continue
            if cheapest is None or v < cheapest:
                cheapest, cheapest_p = v, p
        if cheapest is not None:
            c.setdefault("price", {})
            c["price"]["usd"] = f"{cheapest:.2f}"
            urls = scryfall.normalize_card(cheapest_p).get("purchaseUris") or {}
            if urls.get("tcgplayer"):
                c["price"]["tcgplayerUrl"] = urls["tcgplayer"]
            repriced += 1

    deck_store.save(deck)
    return jsonify({"updated": len(cards), "repriced": repriced, "deck": deck})


@bp.post("/<deck_id>/reload-edhrec")
def reload_edhrec(deck_id: str):
    """Re-pull the commander's EDHREC pool (R5). Refreshes synergy/inclusion on
    existing cards and ADDS any newly-recommended cards (as Undecided, enriched).
    Reuses the same EDHREC + enrichment path as the initial deck build."""
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    commander = deck.get("commander")
    if not commander:
        return jsonify({"error": "Deck has no commander to pull EDHREC data for"}), 400
    try:
        pool = builder.fetch_pool(commander)
    except edhrec.CommanderNotFound:
        return jsonify({"error": f"No EDHREC page found for {commander!r}"}), 404

    pool_by_low = {name.lower(): info for name, info in pool.items()}
    existing = {(c.get("name") or "").lower() for c in deck["cards"]}

    # Refresh EDHREC synergy/inclusion on cards already in the deck.
    for c in deck["cards"]:
        info = pool_by_low.get((c.get("name") or "").lower())
        if info:
            c["edhrecData"] = {"numDecks": info.get("numDecks"),
                               "inclusion": info.get("inclusion"),
                               "synergy": info.get("synergy")}

    # Add newly-recommended cards (not already in the deck) as Undecided.
    new_names = [name for name in pool if name.lower() not in existing]
    norms = builder.enrich_names(new_names)
    nums = [int(c["id"][2:]) for c in deck["cards"]
            if c.get("id", "").startswith("c-") and c["id"][2:].isdigit()]
    idx = (max(nums) + 1) if nums else 1
    added = 0
    for name in new_names:
        norm = norms.get(name.lower())
        primary, tags = tagger.derive(norm) if norm else ("other", ["other"])
        info = pool[name]
        entry = deck_model.new_card_entry(
            name, primary_tag=primary, tags=tags, inclusion_state="undecided",
            scryfall_id=(norm["id"] if norm else None),
            edhrec_data={"numDecks": info.get("numDecks"),
                         "inclusion": info.get("inclusion"),
                         "synergy": info.get("synergy")},
            card_id=f"c-{idx:04d}",
        )
        if norm:
            deck_model.enrich_entry(entry, norm)
        deck["cards"].append(entry)
        idx += 1
        added += 1

    deck_store.save(deck)
    return jsonify({"added": added, "deck": deck})


@bp.post("/<deck_id>/add-edhrec-card")
def add_edhrec_card(deck_id: str):
    """Bulk-add the EDHREC recommendations for a GIVEN card (O2) — cards commonly
    played alongside it — into the deck as Undecided (deduped, enriched)."""
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    card_name = ((request.get_json(silent=True) or {}).get("card") or "").strip()
    if not card_name:
        return jsonify({"error": "card is required"}), 400
    try:
        pool = builder.fetch_pool_for_card(card_name)
    except edhrec.CommanderNotFound:
        return jsonify({"error": f"No EDHREC recommendations found for {card_name!r}"}), 404

    existing = {(c.get("name") or "").lower() for c in deck["cards"]}
    new_names = [name for name in pool if name.lower() not in existing]
    norms = builder.enrich_names(new_names)
    nums = [int(c["id"][2:]) for c in deck["cards"]
            if c.get("id", "").startswith("c-") and c["id"][2:].isdigit()]
    idx = (max(nums) + 1) if nums else 1
    added = 0
    for name in new_names:
        norm = norms.get(name.lower())
        primary, tags = tagger.derive(norm) if norm else ("other", ["other"])
        info = pool[name]
        entry = deck_model.new_card_entry(
            name, primary_tag=primary, tags=tags, inclusion_state="undecided",
            scryfall_id=(norm["id"] if norm else None),
            edhrec_data={"numDecks": info.get("numDecks"), "inclusion": info.get("inclusion"),
                         "synergy": info.get("synergy")},
            card_id=f"c-{idx:04d}",
        )
        if norm:
            deck_model.enrich_entry(entry, norm)
        deck["cards"].append(entry)
        idx += 1
        added += 1

    deck_store.save(deck)
    return jsonify({"added": added, "deck": deck})


# Game designations / dungeons. Each: (display, kind, oracle-needles, token_name).
# `token_name` is the real Scryfall token/marker card we try to resolve so it shows
# with art + a skin picker (e.g. "The Monarch" is a real token — tcn2). When None
# (or unresolved) it falls back to an image-less placeholder extra.
_DESIGNATIONS = [
    ("The Monarch", "designation", ("become the monarch", "becomes the monarch", "you're the monarch", "the monarch"), "The Monarch"),
    ("The Initiative", "designation", ("the initiative",), "The Initiative"),
    ("City's Blessing", "designation", ("city's blessing",), "City's Blessing"),
    ("The Ring", "designation", ("the ring tempts you", "your ring-bearer", "the ring tempts"), "The Ring"),
    ("Dungeons", "dungeon", ("venture into the dungeon",), None),
]


def _oracle_text(raw) -> str:
    """Lower-cased oracle text of a card, merging both faces when present."""
    parts = []
    if raw.get("oracle_text"):
        parts.append(raw["oracle_text"])
    for face in raw.get("card_faces") or []:
        if face.get("oracle_text"):
            parts.append(face["oracle_text"])
    return " \n ".join(parts).lower()


def _resolve_token_card(name: str):
    """Find a real Scryfall token/marker card by name (e.g. 'The Monarch'). Returns
    a normalized card or None."""
    for p in scryfall.printings(name, want="tokens"):
        if (p.get("name") or "").strip().lower() == name.strip().lower():
            return scryfall.normalize_card(p)
    return None


@bp.get("/<deck_id>/tokens")
def deck_tokens(deck_id: str):
    """Tokens + extras the deck's INCLUDED cards make (Scryfall `all_parts` + oracle).

    Tokens are **deduped by identity** (name + type + power/toughness), NOT by
    printing — so the same 4/4 Angel made by two cards is listed ONCE with both
    sources. Real tokens carry a `scryfallId` (frontend skin picker). Designations
    (Monarch, Initiative, …) are resolved to their real token card when one exists,
    else returned as an image-less placeholder extra.
    """
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    in_states = {"locked_in", "in"}
    by_content: dict = {}  # identity key -> token dict

    def add_token(name, sid, image, type_line, power, toughness, source):
        key = ((name or "").lower(), (type_line or "").lower(), str(power), str(toughness))
        t = by_content.get(key)
        if t is None:
            t = by_content[key] = {"name": name, "scryfallId": sid, "image": image,
                                   "typeLine": type_line, "createdBy": set()}
        if source:
            t["createdBy"].add(source)

    designations: dict = {}  # display -> {kind, token_name, createdBy:set}
    for c in deck.get("cards", []):
        if c.get("inclusionState") not in in_states or not c.get("scryfallId"):
            continue
        raw = scryfall.by_id(c["scryfallId"])
        if not raw:
            continue
        # tokens + emblems from all_parts
        for part in raw.get("all_parts") or []:
            comp = part.get("component")
            tl = (part.get("type_line") or "").lower()
            if not part.get("id") or (comp != "token" and "emblem" not in tl):
                continue
            traw = scryfall.by_id(part["id"])
            tnorm = scryfall.normalize_card(traw) if traw else {}
            add_token(tnorm.get("name") or part.get("name"), part["id"],
                      (tnorm.get("image") or {}).get("normal"),
                      tnorm.get("typeLine") or part.get("type_line"),
                      tnorm.get("power"), tnorm.get("toughness"), c["name"])
        # oracle-detected designations / dungeons
        oracle = _oracle_text(raw)
        for disp, kind, needles, token_name in _DESIGNATIONS:
            if any(n in oracle for n in needles):
                d = designations.setdefault(disp, {"kind": kind, "token_name": token_name, "createdBy": set()})
                d["createdBy"].add(c["name"])

    # Resolve designations to a real token card where one exists (Monarch, etc.).
    extras = []
    for disp, info in designations.items():
        tnorm = _resolve_token_card(info["token_name"]) if info["token_name"] else None
        if tnorm:
            for src in info["createdBy"]:
                add_token(tnorm.get("name"), tnorm.get("id"), (tnorm.get("image") or {}).get("normal"),
                          tnorm.get("typeLine"), tnorm.get("power"), tnorm.get("toughness"), src)
        else:
            extras.append({"name": disp, "kind": info["kind"], "scryfallId": None,
                           "image": None, "createdBy": sorted(info["createdBy"])})

    out = [{**t, "createdBy": sorted(t["createdBy"])} for t in by_content.values()]
    out.sort(key=lambda t: t["name"] or "")
    extras.sort(key=lambda t: t["name"])
    return jsonify({"tokens": out + extras})


@bp.delete("/<deck_id>/cards/<card_id>")
def remove_card(deck_id: str, card_id: str):
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    before = len(deck.get("cards", []))
    deck["cards"] = [c for c in deck.get("cards", []) if c.get("id") != card_id]
    if len(deck["cards"]) == before:
        return jsonify({"error": "Card not found"}), 404
    deck_store.save(deck)
    return jsonify({"removed": card_id})


@bp.post("/<deck_id>/refine-tags")
def refine_tags(deck_id: str):
    """Recalculate functional tags for EVERY card (R7).

    Body options:
      removeStale  (bool) — also DROP tags no longer derived (default: keep them).
      resetPrimary (bool) — reset primaryTag to the freshly-derived primary
                            (default: keep the user's primary if still valid).

    Default = **augment**: add newly-derived heuristic tags without removing
    anything or changing the primary — so improved heuristics reach existing decks
    safely. Cards are enriched in one batched /collection pass (by name), so this is
    fast even for a full pool.
    """
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    body = request.get_json(silent=True) or {}
    remove_stale = bool(body.get("removeStale"))
    reset_primary = bool(body.get("resetPrimary"))

    cards = deck.get("cards", [])
    names = sorted({c["name"] for c in cards if c.get("name")})
    norm_by_name = builder.enrich_names(names)

    updated = 0
    for c in cards:
        if c.get("isCommander"):
            continue
        norm = norm_by_name.get((c.get("name") or "").lower()) or {"name": c.get("name")}
        primary, derived = tagger.derive(norm)
        existing = list(c.get("tags") or [])
        if remove_stale:
            newtags = list(derived)
        else:
            newtags = existing[:]
            for t in derived:
                if t not in newtags:
                    newtags.append(t)
        if not newtags:
            newtags = ["other"]
        if reset_primary:
            c["primaryTag"] = primary
        elif c.get("primaryTag") not in newtags:
            c["primaryTag"] = newtags[0]
        c["tags"] = newtags
        updated += 1

    deck_store.save(deck)
    return jsonify({"updated": updated, "deck": deck})


@bp.post("/<deck_id>/cards/<card_id>/enrich")
def enrich_card(deck_id: str, card_id: str):
    """Resolve a card that still has scryfallId=null (EDHREC not_found / edge cases)."""
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    card = _find_card(deck, card_id)
    if card is None:
        return jsonify({"error": "Card not found"}), 404
    if card.get("scryfallId"):
        return jsonify(card)  # already enriched
    raw = scryfall.named(card["name"])
    if raw is None:
        return jsonify({"error": f"'{card['name']}' not found on Scryfall"}), 422
    norm = scryfall.normalize_card(raw)
    deck_model.enrich_entry(card, norm)
    deck_store.save(deck)
    return jsonify(card)
