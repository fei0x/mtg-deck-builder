"""Deck collection + item API routes (per API Contract B in plan/00).

  GET    /api/decks            list summaries
  POST   /api/decks            create a deck (EDHREC population added in 04)
  GET    /api/decks/<id>       full deck
  PUT    /api/decks/<id>       replace/save full deck (auto-save target)
  PATCH  /api/decks/<id>       patch metadata/settings
  DELETE /api/decks/<id>       delete
"""
from flask import Blueprint, jsonify, request

from ..services import builder, deck_model, deck_store, edhrec

bp = Blueprint("decks", __name__, url_prefix="/api/decks")


@bp.get("")
def list_decks():
    return jsonify({"decks": deck_store.list_decks()})


@bp.post("")
def create_deck():
    """Create a deck.

    With a `commander`, runs the full EDHREC build (pool -> tags -> workspace).
    Without one (or with `empty: true`), creates an empty deck. EDHREC/Scryfall
    miss -> 422 so the UI can offer "start with an empty deck".
    """
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    commander = (body.get("commander") or "").strip()
    fmt = (body.get("format") or "commander").strip() or "commander"
    if commander and not body.get("empty"):
        try:
            deck = builder.build_from_commander(
                commander, deck_name=name, description=(body.get("description") or ""), fmt=fmt)
        except (builder.CommanderNotFound, edhrec.CommanderNotFound):
            return jsonify({
                "error": f"No EDHREC recommendations found for '{commander}'. "
                         f"You can start with an empty deck instead.",
                "code": "edhrec_not_found",
            }), 422
        except ValueError as exc:  # commander not on Scryfall
            return jsonify({"error": str(exc), "code": "commander_not_found"}), 422
    else:
        deck = deck_model.new_deck(
            name,
            commander=(commander or None),
            commander_scryfall_id=(body.get("commanderScryfallId") or None),
            description=(body.get("description") or ""),
            fmt=fmt,
        )

    deck = deck_store.save(deck)
    return jsonify(deck), 201


@bp.get("/<deck_id>")
def get_deck(deck_id: str):
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    return jsonify(deck)


@bp.put("/<deck_id>")
def put_deck(deck_id: str):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "deck body required"}), 400
    body["id"] = deck_id  # id is path-authoritative
    try:
        deck = deck_store.save(body)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(deck)


@bp.patch("/<deck_id>")
def patch_deck(deck_id: str):
    deck = deck_store.load(deck_id)
    if deck is None:
        return jsonify({"error": "Deck not found"}), 404
    body = request.get_json(silent=True) or {}
    for key in ("name", "description", "bucketingMode", "format"):
        if key in body:
            deck[key] = body[key]
    if "settings" in body and isinstance(body["settings"], dict):
        deck["settings"] = {**deck.get("settings", {}), **body["settings"]}
    deck = deck_store.save(deck)
    return jsonify(deck)


@bp.delete("/<deck_id>")
def delete_deck(deck_id: str):
    if not deck_store.delete(deck_id):
        return jsonify({"error": "Deck not found"}), 404
    return jsonify({"deleted": deck_id})
