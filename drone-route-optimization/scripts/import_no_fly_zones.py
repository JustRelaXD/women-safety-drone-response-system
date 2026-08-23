"""One-time: download DGCA airspace zones and build the local snapshot.

    uv run python scripts/import_no_fly_zones.py                       # Punjab bbox
    uv run python scripts/import_no_fly_zones.py --bbox 75.5,30.5,76.5,31.5
    uv run python scripts/import_no_fly_zones.py --bbox none            # whole of India
    uv run python scripts/import_no_fly_zones.py --out planner/data/no_fly_zones.json

What it does:
1. One GET against the (public, unauthenticated) airspace map backend -
   the same data the airspacemap.in map renders.
2. Converts every red / inner-yellow / outer-yellow / approach polygon that
   overlaps the requested bbox into planner ``(lat, lon)`` rings.
3. Writes ``planner/data/no_fly_zones.json``: typed rings + a UTC download
   timestamp, so the planner stays fully offline and the snapshot's age is
   always visible.

Zone kinds follow what the geometry actually is:

- red  = the runway/airfield footprint itself (a drone must never fly
  through the runway) - the only hard obstacle
- amber = EVERYTHING else around an airfield - the approach/departure
  funnels extending from the runway ends (the "two triangular shapes")
  and the large round controlled-airspace circles (inner/outer yellow) -
  passable with prior permission, reported on the route as
  ``zones_crossed``

Re-run on a schedule to refresh (the data is dynamic).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from planner.core.config import Settings  # noqa: E402
from planner.overture.no_fly import (  # noqa: E402
    AIRSPACE_BACKEND_URL,
    DEFAULT_SNAPSHOT,
    fetch_facilities,
    write_no_fly_zones,
    zones_from_facilities,
)

#: default operating area: Punjab (lon 73.5..77.0, lat 29.5..32.5)
PUNJAB_BBOX = (73.5, 29.5, 77.0, 32.5)


def main() -> None:
    ap = argparse.ArgumentParser(description="Import DGCA airspace no-fly zones")
    ap.add_argument("--url", default=AIRSPACE_BACKEND_URL, help="facilities API URL")
    ap.add_argument(
        "--bbox",
        default="punjab",
        help="xmin,ymin,xmax,ymax (lon,lat,lon,lat); 'none' for all India",
    )
    ap.add_argument("--out", default=DEFAULT_SNAPSHOT, help="output JSON path")
    ap.add_argument(
        "--input",
        default=None,
        help="local facilities JSON (a previously fetched payload) - skips the network",
    )
    ap.add_argument(
        "--airport-red-radius-km",
        type=float,
        default=None,
        help="replaces the DGCA airport no-drone circle (11-14 km wide) with "
        "a circle of this radius (km) around the airport reference point, so "
        "cities with an airport at their centre stay reachable; 0 keeps the "
        "DGCA circle.  Default: PLANNER_AIRPORT_RED_RADIUS_KM or 1.0",
    )
    args = ap.parse_args()

    bbox: tuple[float, float, float, float] | None
    if args.bbox.lower() == "none":
        bbox = None
    elif args.bbox.lower() == "punjab":
        bbox = PUNJAB_BBOX
        print(f"bbox: Punjab {PUNJAB_BBOX}")
    else:
        xmin, ymin, xmax, ymax = (float(v) for v in args.bbox.split(","))
        bbox = (xmin, ymin, xmax, ymax)
        print(f"bbox: {bbox}")

    if args.input:
        print(f"reading facilities from {args.input} (no network)...")
        facilities = json.loads(Path(args.input).read_text(encoding="utf-8"))
    else:
        print(f"fetching facilities from {args.url} ...")
        facilities = fetch_facilities(args.url)
    if not isinstance(facilities, list):
        sys.exit(
            "--input must point to a raw facilities JSON list, not a snapshot "
            "(a snapshot has {\"zones\": [...]}).  Pass the payload saved from "
            "the facilities API instead."
        )
    print(f"  {len(facilities)} facilities")

    radius = args.airport_red_radius_km
    if radius is None:
        radius = Settings.from_env().airport_red_radius_km
    if radius > 0:
        print(f"  shrinking airport no-drone circles to {radius:.1f} km radius")
    else:
        print("  keeping DGCA airport no-drone circles as-is (radius=0)")

    zones = zones_from_facilities(facilities, bbox, airport_red_radius_km=radius)
    n_red = sum(1 for z in zones if z.kind == "red")
    n_amber = sum(1 for z in zones if z.kind == "amber")
    print(f"  zones in bbox: {len(zones)}  (red={n_red}, amber={n_amber})")

    # honest provenance: --input means no network was involved
    source = args.input or args.url
    payload = write_no_fly_zones(args.out, zones, source)
    print(f"wrote {args.out} ({Path(args.out).stat().st_size / 1024:.1f} KiB)")
    print(f"  fetched_at: {payload['fetched_at']}")
    print("The planner picks this file up via PLANNER_NO_FLY_ZONES_FILE or config.")


if __name__ == "__main__":
    main()
