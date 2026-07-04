"""Meta endpoints: app-level reference data (not deck- or card-specific)."""
import requests
from flask import Blueprint, jsonify

from ..services import cache, tagger

bp = Blueprint("meta", __name__, url_prefix="/api")

_FX_FALLBACK = 1.36  # USD->CAD if the live rate can't be fetched


@bp.get("/tags")
def tags():
    """Full functional-tag catalog: key, display, description, heuristic."""
    return jsonify({"tags": tagger.tag_catalog()})


@bp.get("/fx")
def fx():
    """USD->CAD exchange rate (cached ~1 day; free no-key source w/ fallback)."""
    cached = cache.get("fx", "usd_cad", ttl=86400)
    if cached is not None:
        return jsonify(cached)
    rate, source = _FX_FALLBACK, "fallback"
    try:
        r = requests.get("https://open.er-api.com/v6/latest/USD", timeout=10,
                         headers={"User-Agent": "CommanderDeckBuilder/0.1"})
        if r.status_code == 200:
            cad = (r.json().get("rates") or {}).get("CAD")
            if cad:
                rate, source = float(cad), "open.er-api.com"
    except requests.RequestException:
        pass
    out = {"usdCad": round(rate, 4), "source": source}
    cache.set("fx", "usd_cad", out)
    return jsonify(out)
