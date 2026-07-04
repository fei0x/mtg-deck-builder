"""Deck price aggregation. Thin wrapper over deck_model so the formula stays in
one place (sum of price.usd over included cards — locked_in + in). No Flask."""
from typing import Any, Dict

from . import deck_model


def deck_total(deck: Dict[str, Any]) -> float:
    """Total USD over included cards (skips nulls), per 03's formula."""
    return deck_model.total_price(deck)


def breakdown(deck: Dict[str, Any]) -> Dict[str, Any]:
    """Total + per-card prices for the included cards (the buy list)."""
    cards = []
    for c in deck.get("cards", []):
        if c.get("inclusionState") not in deck_model.IN_STATES:
            continue
        cards.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "quantity": c.get("quantity", 1),
            "usd": (c.get("price") or {}).get("usd"),
            "tcgplayerUrl": (c.get("price") or {}).get("tcgplayerUrl"),
        })
    return {"total": deck_total(deck), "currency": "usd", "cards": cards}
