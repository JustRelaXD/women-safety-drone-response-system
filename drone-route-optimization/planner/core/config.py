"""Central configuration for the planner.

A frozen dataclass so instances are safe to share across requests; every knob
the user listed is here: grid resolution, safety margin, altitude, memory
limit, DuckDB settings, bounding-box expansion.  Per-request overrides are
created with ``dataclasses.replace``.
"""

from __future__ import annotations

import dataclasses
import logging
import os
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger(__name__)

#: A no-fly zone is a closed ring of (lat, lon) vertices.
NoFlyRing = tuple[tuple[float, float], ...]

#: zone kinds the planner understands.  Green is absent from the data: it is
#: "everything else" and always allowed.
ZoneKind = Literal["red", "amber"]


@dataclass(frozen=True)
class ZoneRecord:
    """One airspace polygon with its kind and a human label.

    ``kind`` decides how the planner treats it:

    - ``"red"`` - prohibited under any circumstances.  Always an obstacle:
      rasterised onto the grid and it blocks the direct-line fast path.
      For airfields this is the runway/airfield footprint itself.
    - ``"amber"`` - controlled airspace an emergency drone may enter WITH
      prior permission.  Never an obstacle; every crossing is reported on
      the route (``zones_crossed``) so the operator can request permission
      and notify the airport authority.  This includes the approach/departure
      funnels around airfields (the "two triangular shapes" pointing away
      from the runway) AND the large round controlled-airspace circles:
      the funnels are tens of km long, so blocking them would make whole
      cities with an airport unreachable - they are treated like any other
      controlled airspace instead.
    """

    kind: ZoneKind
    ring: NoFlyRing
    name: str


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _parse_no_fly_scope_files(raw: str, default_file: str) -> dict[str, str]:
    """Parse ``name=path;name=path`` into a scope->file map.

    An empty string falls back to the two known snapshots (punjab follows
    ``PLANNER_NO_FLY_ZONES_FILE`` when it is set; india is the all-india
    snapshot produced by ``scripts/import_no_fly_zones.py --bbox none``).
    """
    if raw.strip():
        files: dict[str, str] = {}
        for pair in raw.split(";"):
            if "=" not in pair:
                continue
            name, path = pair.split("=", 1)
            if name.strip() and path.strip():
                files[name.strip()] = path.strip()
        return files
    return {
        "punjab": default_file or "planner/data/no_fly_zones.json",
        "india": "planner/data/no_fly_zones_india.json",
    }


@dataclass(frozen=True)
class Settings:
    # --- grid / planning -------------------------------------------------
    #: pathfinding algorithm.  Benchmark-justified default (see README
    #: section 7): A* + LOS smoothing is within 1-3 % of optimal path length
    #: while being 3-30x faster than Theta* (which stays as an opt-in for
    #: path-quality-critical missions).  "visibility" is the exact shortest
    #: path but O(V^2) to build - a sub-2 km reference tool only.
    planner_algorithm: Literal["astar", "theta_star", "visibility"] = "astar"
    #: caps for the visibility-graph planner (construction is O(V^2);
    #: measured ~8 s at 500 m and ~42 s at 1 km on real Punjab data, and
    #: ~323 s at 2 km, so the exact planner is a small-region tool).  The
    #: building cap of 1500 rejects 2 km+ boxes (1725 buildings) fast with
    #: InfeasibleError instead of a 5-minute build.
    visibility_max_buildings: int = 1_500
    visibility_max_vertices: int = 4_000
    grid_resolution_m: float = 10.0
    #: cap on grid cells; larger boxes automatically get coarser cells
    max_grid_cells: int = 4_000_000
    safety_margin_m: float = 0.0
    #: building footprint buffer used by exact-polygon rasterization.  The
    #: old path blocked each building's buffered BOUNDING BOX (over-blocking
    #: empty corners, then again via grid snapping); the exact path blocks
    #: every cell whose rectangle intersects buffer(footprint, this) - the
    #: true clearance commitment for the grid corridor.  At plan() time the
    #: effective buffer is min(polygon_buffer_m, safety_margin_m), so the
    #: safety margin (the user-facing knob) can tighten the corridor all the
    #: way down to 0 m but never widen it beyond this config default.
    polygon_buffer_m: float = 1.0
    #: paint obstacles exactly (polygon + polygon_buffer_m) instead of the
    #: buffered bounding box.  The envelope path stays available as a
    #: fallback for benchmarking / comparison (``raster_envelope_max_cells``
    #: only applies to it).
    rasterize_exact_polygons: bool = True
    default_altitude_m: float = 50.0
    min_waypoint_spacing_m: float = 25.0
    #: expand the mission bbox by this much before querying the dataset,
    #: so obstacles just outside the corridor still get rasterised
    bbox_expansion_m: float = 200.0
    #: obstacles whose cell envelope is larger than this are rasterised
    #: exactly (point-in-polygon); smaller ones block their whole envelope
    raster_envelope_max_cells: int = 4096
    #: red-zone reroute: when the grid search fails because a RED zone seals
    #: the corridor (e.g. an airport's no-drone circle spanning 10+ km), the
    #: degraded fallback retries the grid search on a larger box sized to
    #: contain the blocking ring(s) plus this per-side cap (m).
    #: This is what lets the planner route AROUND a red zone and still reach
    #: the destination instead of stopping at the zone edge.  0 disables the
    #: reroute (previous behaviour).
    red_reroute_max_expansion_m: float = 20_000.0
    #: airport no-drone circle radius (km).  The DGCA data ships each
    #: ``type=airport`` facility with a large (~11-14 km wide) red no-drone
    #: circle around the airport - the "centre red circle" that made whole
    #: cities with an airport unreachable.  The import replaces that ring
    #: with a circle of this radius around the airport reference point
    #: (0 = keep the DGCA circle as-is).  The tiny runway footprint
    #: (``type=approach`` red) and every non-airport red zone (border
    #: strips, cantonments, jails, railway stations) are untouched.
    airport_red_radius_km: float = 1.0

    # --- DuckDB ----------------------------------------------------------
    memory_limit: str = "512MB"
    threads: int = 1
    temp_directory: str = "planner/data/spill"
    buildings_parquet: str = "punjab_buildings.parquet"
    water_parquet: str | None = None
    #: None -> in-memory DuckDB; otherwise a file-backed .duckdb
    region_db_path: str | None = None
    build_rtree: bool = True

    # --- mission ---------------------------------------------------------
    drone_speed_mps: float = 15.0

    # --- static no-fly zones (typed records; request zones are added as red)
    #: red = prohibited (obstacle), amber = passable-with-permission (reported
    #: via ``zones_crossed`` on the route, never an obstacle)
    no_fly_zones: tuple[ZoneRecord, ...] = ()
    #: local snapshot of DGCA airspace zones (``planner/data/no_fly_zones.json``
    #: produced by ``scripts/import_no_fly_zones.py``).  When set, its records
    #: are loaded at construction time into ``no_fly_zones``; the same file
    #: also feeds the default (``punjab``) scope of ``GET /no-fly-zones`` for
    #: the frontend overlay.
    no_fly_zones_file: str | None = None
    #: named overlay scopes served by ``GET /no-fly-zones?scope=...``:
    #: scope name -> snapshot file path.  Populated by :meth:`from_env` from
    #: ``PLANNER_NO_FLY_ZONES_FILES`` (``name=path;name=path``) with defaults
    #: for the punjab + all-india snapshots produced by
    #: ``scripts/import_no_fly_zones.py``.  These are DISPLAY-only: they feed
    #: the frontend overlay, never the planner's obstacle set (which uses
    #: ``no_fly_zones`` / ``no_fly_zones_file``).
    no_fly_zones_files: dict[str, str] = dataclasses.field(default_factory=dict)

    # --- construction ----------------------------------------------------
    @classmethod
    def from_env(cls) -> "Settings":
        """Build settings from ``PLANNER_*`` environment variables."""
        def f(name: str, default: float) -> float:
            return float(_env(name, str(default)))

        algo = _env("PLANNER_ALGORITHM", "astar").strip().lower()
        if algo not in ("astar", "theta_star", "visibility"):
            algo = "astar"
        return cls(
            planner_algorithm=algo,
            visibility_max_buildings=int(
                f("PLANNER_VISIBILITY_MAX_BUILDINGS", 1_500)
            ),
            visibility_max_vertices=int(
                f("PLANNER_VISIBILITY_MAX_VERTICES", 4_000)
            ),
            grid_resolution_m=f("PLANNER_GRID_RESOLUTION_M", 10.0),
            max_grid_cells=int(f("PLANNER_MAX_GRID_CELLS", 4_000_000)),
            safety_margin_m=f("PLANNER_SAFETY_MARGIN_M", 0.0),
            polygon_buffer_m=f("PLANNER_POLYGON_BUFFER_M", 1.0),
            rasterize_exact_polygons=_env("PLANNER_RASTERIZE_EXACT_POLYGONS", "1").strip().lower()
            not in ("0", "false", "no"),
            default_altitude_m=f("PLANNER_ALTITUDE_M", 50.0),
            min_waypoint_spacing_m=f("PLANNER_WAYPOINT_SPACING_M", 25.0),
            bbox_expansion_m=f("PLANNER_BBOX_EXPANSION_M", 200.0),
            red_reroute_max_expansion_m=f(
                "PLANNER_RED_REROUTE_MAX_EXPANSION_M", 20_000.0
            ),
            airport_red_radius_km=f("PLANNER_AIRPORT_RED_RADIUS_KM", 1.0),
            memory_limit=_env("PLANNER_MEMORY_LIMIT", "512MB"),
            threads=int(_env("PLANNER_THREADS", "1")),
            temp_directory=_env("PLANNER_TEMP_DIRECTORY", "planner/data/spill"),
            buildings_parquet=_env("PLANNER_BUILDINGS_PARQUET", "punjab_buildings.parquet"),
            water_parquet=_env("PLANNER_WATER_PARQUET", "") or None,
            region_db_path=_env("PLANNER_REGION_DB", "") or None,
            build_rtree=_env("PLANNER_BUILD_RTREE", "1") != "0",
            drone_speed_mps=f("PLANNER_SPEED_MPS", 15.0),
            no_fly_zones_file=_env("PLANNER_NO_FLY_ZONES_FILE", "") or None,
            no_fly_zones_files=_parse_no_fly_scope_files(
                _env("PLANNER_NO_FLY_ZONES_FILES", ""),
                _env("PLANNER_NO_FLY_ZONES_FILE", ""),
            ),
        )

    @classmethod
    def from_env_with_no_fly(cls) -> "Settings":
        """``from_env`` plus no-fly records loaded from the best available file.

        Loading happens here (not in :meth:`from_env`) so tests and callers
        that construct :class:`Settings` directly never touch the filesystem,
        and so the API layer can decide when file I/O is acceptable.

        The configured ``no_fly_zones_file`` may be missing or empty on a
        given deployment (e.g. an env pointing at a punjab snapshot that was
        never downloaded).  ``load_no_fly_zones`` treats a missing file as an
        empty snapshot, which would silently disable red-zone blocking and
        let drones fly straight through prohibited airspace.  To close that
        footgun the file is resolved with a fallback chain: the configured
        file, then the india snapshot, then the punjab snapshot.  A warning
        is logged whenever the configured file is skipped.
        """
        cfg = cls.from_env()
        from ..overture.no_fly import load_no_fly_zones

        candidates = [
            (cfg.no_fly_zones_file, "configured PLANNER_NO_FLY_ZONES_FILE"),
            (cfg.no_fly_zones_files.get("india"), "india snapshot"),
            (cfg.no_fly_zones_files.get("punjab"), "punjab snapshot"),
        ]
        for path, label in candidates:
            if not path:
                continue
            records = tuple(load_no_fly_zones(path))
            if not records:
                continue
            if path != cfg.no_fly_zones_file:
                logger.warning(
                    "no-fly zones file %r is missing or empty - falling back to the %s (%s zones)",
                    cfg.no_fly_zones_file,
                    label,
                    len(records),
                )
            return dataclasses.replace(cfg, no_fly_zones=records)
        if cfg.no_fly_zones_file:
            logger.warning(
                "no-fly zones file %r is missing or empty and no fallback snapshot exists - routing will NOT block red zones",
                cfg.no_fly_zones_file,
            )
        return cfg

    @property
    def obstacle_rings(self) -> tuple[NoFlyRing, ...]:
        """Rings of the RED zones only - the hard obstacles.

        Amber zones are passable with permission and are never rasterised
        or tested by the direct-line check; they surface only as
        ``zones_crossed`` on the computed route.
        """
        return tuple(z.ring for z in self.no_fly_zones if z.kind == "red")
