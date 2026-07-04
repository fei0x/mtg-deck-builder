"""Entry point: ``python -m app`` runs the local dev server.

The reloader is disabled so start.ps1's "wait for port, then open browser"
sequence sees a single, stable process (the reloader would spawn a child and
confuse process tracking).
"""
from . import config
from . import create_app


def main() -> None:
    app = create_app()
    print(f"Commander Deck Builder running at http://localhost:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=True, use_reloader=False)


if __name__ == "__main__":
    main()
