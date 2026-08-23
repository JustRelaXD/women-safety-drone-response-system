"""One planner benchmark scenario (fresh subprocess, emits JSON).

Runs the full Phase-2 pipeline on the real Punjab parquet for a mission whose
bounding box is ``size`` x ``size`` (start/goal at opposite corners).  If the
start or goal lands inside a dense village cluster with no 10 m corridor (a
real property of dense Indian urban layouts - see README), the scenario
retries with the centre shifted up to ~600 m in eight directions and reports
which centre was used.  Peak RSS is per-process ``ru_maxrss`` thanks to
subprocess isolation.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from planner.core.config import Settings
from planner.core.exceptions import InfeasibleError, NoPathError
from planner.core.geometry import haversine_m
from planner.overture.memory import peak_rss_kb
from planner.routing.planner import RoutePlanner


def _corners(lat: float, lon: float, size_m: int) -> tuple[tuple[float, float], tuple[float, float]]:
    offset = size_m * 0.5
    dlat = offset / 111_320.0
    dlon = offset / (111_320.0 * math.cos(math.radians(lat)))
    return (lat - dlat, lon - dlon), (lat + dlat, lon + dlon)


def _candidate_centers(lat: float, lon: float):
    yield (lat, lon)
    ring = 0.006  # ~660 m
    for dlat, dlon in [
        (ring, 0), (-ring, 0), (0, ring), (0, -ring),
        (ring, ring), (ring, -ring), (-ring, ring), (-ring, -ring),
    ]:
        yield (lat + dlat, lon + dlon)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--size", type=int, required=True, help="mission box side in metres")
    ap.add_argument("--resolution", type=float, default=10.0)
    ap.add_argument("--safety", type=float, default=5.0)
    ap.add_argument(
        "--algorithm",
        default=None,
        choices=["astar", "theta_star", "visibility"],
        help="default: Settings().planner_algorithm",
    )
    ap.add_argument("--max-buildings", type=int, default=None,
                    help="default: Settings().visibility_max_buildings")
    ap.add_argument("--max-vertices", type=int, default=None,
                    help="default: Settings().visibility_max_vertices")
    args = ap.parse_args()

    defaults = Settings()
    settings = Settings(
        planner_algorithm=args.algorithm or defaults.planner_algorithm,
        visibility_max_buildings=args.max_buildings or defaults.visibility_max_buildings,
        visibility_max_vertices=args.max_vertices or defaults.visibility_max_vertices,
        grid_resolution_m=args.resolution,
        safety_margin_m=args.safety,
        default_altitude_m=50.0,
        min_waypoint_spacing_m=25.0,
        bbox_expansion_m=200.0,
        memory_limit="512MB",
        threads=1,
        buildings_parquet=args.parquet,
        water_parquet=None,
        build_rtree=True,
    )

    out: dict = {"size_m": args.size, "algorithm": settings.planner_algorithm}
    t_wall0 = time.perf_counter()
    t_cpu0 = time.process_time()

    for clat, clon in _candidate_centers(args.lat, args.lon):
        start, goal = _corners(clat, clon, args.size)
        planner = RoutePlanner(settings)
        try:
            result = planner.plan(
                start=start,
                goal=goal,
                mission_id=f"bench-{args.size}",
                altitude_m=50.0,
                snap_start_goal=True,  # corners may land on a building
            )
            out["center_used"] = [round(clat, 5), round(clon, 5)]
            break
        except NoPathError:
            continue
        except InfeasibleError as exc:
            print(json.dumps({"size_m": args.size,
                              "algorithm": settings.planner_algorithm,
                              "infeasible": str(exc)}))
            return
        finally:
            planner.close()
    else:
        print(json.dumps({"size_m": args.size, "algorithm": settings.planner_algorithm,
                           "error": "no path at any candidate center"}))
        return

    out["planning_wall_s"] = round(time.perf_counter() - t_wall0, 3)
    out["planning_cpu_s"] = round(time.process_time() - t_cpu0, 3)
    out["distance_m"] = result.distance
    out["estimated_time_s"] = result.estimated_time
    out["straight_line_m"] = round(haversine_m(*start, *goal), 1)
    out["waypoints"] = len(result.waypoints)
    out["buildings_queried"] = result.stats.buildings_queried
    out["water_queried"] = result.stats.water_queried
    out["grid_dims"] = [result.stats.grid_width, result.stats.grid_height]
    out["cell_size_m"] = result.stats.cell_size_m
    out["nodes_explored"] = result.stats.nodes_explored
    out["path_cells"] = result.stats.path_cells
    out["graph_vertices"] = result.stats.graph_vertices
    out["graph_edges"] = result.stats.graph_edges
    out["vis_build_s"] = result.stats.vis_build_time_s
    out["vis_search_s"] = result.stats.vis_search_time_s
    out["peak_rss_mb"] = round(peak_rss_kb() / 1024.0, 1)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
