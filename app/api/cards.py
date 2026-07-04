"""Card API routes: a thin layer over the Scryfall service (+ normalizer).

Endpoints (per API Contract B in plan/00):
  GET /api/cards/autocomplete?q=
  GET /api/cards/search?q=&unique=&order=
  GET /api/cards/<id>
  GET /api/cards/<id>/printings
  GET /api/cards/<id>/rulings
"""
from flask import Blueprint, jsonify, request

from ..services import scryfall

bp = Blueprint("cards", __name__, url_prefix="/api/cards")


@bp.get("/autocomplete")
def autocomplete():
    q = request.args.get("q", "")
    return jsonify({"data": scryfall.autocomplete(q)})


@bp.get("/search")
def search():
    q = request.args.get("q", "")
    if not q:
        return jsonify({"cards": []})
    order = request.args.get("order", "name")
    unique = request.args.get("unique")
    raw = scryfall.search(q, order=order, unique=unique, max_pages=1)
    return jsonify({"cards": [scryfall.normalize_card(c) for c in raw]})


@bp.get("/printings")
def printings_by_name():
    """All printings of a card NAME (robust against a stale/wrong scryfallId).

    The drawer's printing picker uses this so the list always reflects the deck
    entry's name — see app/api/build.py reenrich for the matching server-side heal.
    Pass ?kind=token when the entity being skinned is itself a token (the
    Tokens panel's picker) so it gets token/emblem printings instead of the
    real card's — a card and the token it creates can share an exact name.
    """
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"printings": []})
    want = "tokens" if request.args.get("kind") == "token" else "cards"
    raw = scryfall.printings(name, want=want)
    return jsonify({"printings": [scryfall.normalize_card(c) for c in raw]})


@bp.get("/<scryfall_id>")
def card_detail(scryfall_id: str):
    card = scryfall.by_id(scryfall_id)
    if card is None:
        return jsonify({"error": "Card not found"}), 404
    return jsonify(scryfall.normalize_card(card))


@bp.get("/<scryfall_id>/printings")
def card_printings(scryfall_id: str):
    card = scryfall.by_id(scryfall_id)
    if card is None:
        return jsonify({"error": "Card not found"}), 404
    raw = scryfall.printings(card["name"])
    return jsonify({"printings": [scryfall.normalize_card(c) for c in raw]})


@bp.get("/<scryfall_id>/rulings")
def card_rulings(scryfall_id: str):
    return jsonify({"rulings": scryfall.rulings(scryfall_id)})
