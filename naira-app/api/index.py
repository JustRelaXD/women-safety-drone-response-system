"""Vercel serverless entrypoint for the Naira Safety Response API.

Loads the FastAPI ``app`` from ``backend/server.py``. Vercel's Python
runtime does not run FastAPI startup events, so the mock database is
seeded from ``backend/data/naira_db.json`` explicitly on cold start
(best-effort — the API works fine with an empty database).
"""
import asyncio

from backend.server import app, init_db_from_file


def _seed_mock_db() -> None:
    try:
        asyncio.run(init_db_from_file())
    except Exception:
        # Seeding is best-effort; never block startup on it.
        pass


_seed_mock_db()
