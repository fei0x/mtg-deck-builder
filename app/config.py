"""Central configuration: absolute paths and constants.

Paths resolve relative to the project root regardless of the current working
directory, so the app behaves the same whether launched via start.ps1 or
`python -m app` from any folder.
"""
import os
from pathlib import Path

# Project root = parent of the `app` package directory.
ROOT = Path(__file__).resolve().parent.parent

APP_DIR = ROOT / "app"
STATIC_DIR = ROOT / "static"
DATA_DIR = APP_DIR / "data"
DECKS_DIR = ROOT / "decks"
CACHE_DIR = ROOT / "cache"

# Server. PORT honors the env var (lets the preview/launch tooling assign a
# port); defaults to 5000 for start.ps1 and direct `python -m app` runs.
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "5000"))

# Cache time-to-live for fetched card/recommendation data (seconds).
CACHE_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days


def ensure_dirs() -> None:
    """Create the runtime data directories if they don't already exist."""
    for d in (DECKS_DIR, CACHE_DIR, DATA_DIR):
        d.mkdir(parents=True, exist_ok=True)
