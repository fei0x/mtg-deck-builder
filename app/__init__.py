"""Flask application factory.

Serves the single-page frontend from ``static/`` and exposes the JSON API under
``/api``. Blueprints for the API are registered here as later plan steps add
them (cards: 02, decks: 03, build: 04, io: 05).
"""
from flask import Flask, jsonify, send_from_directory

from . import config


def create_app() -> Flask:
    config.ensure_dirs()

    # static_url_path="" serves files in static/ directly at the root
    # (e.g. /css/theme.css -> static/css/theme.css). Explicit literal routes
    # such as /api/health take precedence over the static catch-all.
    app = Flask(
        __name__,
        static_folder=str(config.STATIC_DIR),
        static_url_path="",
    )

    @app.route("/")
    def index():
        return send_from_directory(config.STATIC_DIR, "index.html")

    @app.route("/api/health")
    def health():
        return jsonify({"status": "ok"})

    _register_blueprints(app)
    return app


def _register_blueprints(app: Flask) -> None:
    """Register API blueprints. Populated by later plan steps (02-05)."""
    # Each import is guarded so the app still boots before a module exists.
    try:
        from .api.cards import bp as cards_bp  # 02
        app.register_blueprint(cards_bp)
    except ImportError:
        pass
    try:
        from .api.meta import bp as meta_bp  # 02 (tag reference)
        app.register_blueprint(meta_bp)
    except ImportError:
        pass
    try:
        from .api.decks import bp as decks_bp  # 03
        app.register_blueprint(decks_bp)
    except ImportError:
        pass
    try:
        from .api.build import bp as build_bp  # 04
        app.register_blueprint(build_bp)
    except ImportError:
        pass
    try:
        from .api.io import bp as io_bp  # 05
        app.register_blueprint(io_bp)
    except ImportError:
        pass
