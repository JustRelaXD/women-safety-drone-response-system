#!/usr/bin/env python3
"""Export the backend's OpenAPI schema for frontend type generation.

Run from the repository root (the Python backend):

    uv run python frontend/scripts/export-openapi.py

This imports the FastAPI app and dumps its runtime OpenAPI schema to
frontend/openapi.json - no server, no data, no DuckDB needed.  Then:

    cd frontend && npm run generate:api

regenerates src/types/api.generated.ts from that schema, keeping the React
app's API types in lockstep with the backend models as they evolve.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Running `uv run python frontend/scripts/export-openapi.py` puts this script's
# own directory on sys.path, not the repo root where the `planner` package
# lives.  Insert the repo root explicitly so the import works from anywhere.
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

OUT = ROOT / "frontend" / "openapi.json"


def main() -> None:
    from planner.api.main import app

    OUT.write_text(json.dumps(app.openapi(), indent=2), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
