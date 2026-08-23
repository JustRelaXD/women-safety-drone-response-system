"""FastAPI REST layer.

Endpoints
---------
- ``POST /generate-route``  stateless plan from start to goal
- ``POST /generate-route/stream``  same plan, streamed as NDJSON so the
  client can draw the route as it is computed (partial waypoints before
  the final answer; a ``complete`` event ends the stream)
- ``POST /replan``          replan from a new current position to a goal
- ``POST /mission``         register a mission, plan it, store it
- ``GET  /health``          service + data availability

The API only exchanges GPS waypoints - no drone protocol knowledge.  Any
controller (PX4, ROS2, ArduPilot, ...) can call it through plain HTTP.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import threading
import uuid
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger(__name__)

from .. import __version__
from ..core.config import Settings

# Grid-resolution default (used only when a request does not send
# grid_resolution_m): start every route on the fast coarse 10 m grid - most
# corridors are found there quickly.  When a corridor does NOT exist at the
# coarse grid, the planner's degraded path re-runs the search at finer grids
# (5 m, then 2.5 m) before giving up (see RoutePlanner._plan_finer_grid), so
# dense-street routes still resolve precisely - only genuinely tight routes
# pay for the finer rasterization.  An explicit grid_resolution_m from the
# client always wins.
_GRID_DEFAULT_M = 10.0


def _default_grid_resolution_m(req: Any) -> float:
    """Pick the grid resolution for a request that did not specify one."""
    return _GRID_DEFAULT_M
from ..core.exceptions import InfeasibleError, NoPathError, PlannerError
from ..core.missions import Mission, MissionStore
from ..models.requests import MissionCreateRequest, MissionRequest, ReplanRequest
from ..models.responses import (
    HealthResponse,
    MissionResponse,
    NoFlyZoneInfo,
    NoFlyZoneScopeInfo,
    NoFlyZonesResponse,
    RouteResponse,
    Waypoint,
)
from ..overture.no_fly import filter_zones_by_bbox, load_no_fly_snapshot
from ..routing.planner import RoutePlanner

def _require_api_key(request: Request) -> None:
    """Optional shared-secret guard for the public tunnel URL.

    Enforced only when ``PLANNER_API_KEY`` is set (default: off, so local
    dev and the existing test suite keep working unchanged).  When set, every
    planning endpoint requires the ``X-API-Key`` header to match - the URL
    is public (published via the outbound tunnel), so this stops strangers
    from burning route-compute CPU.  ``GET /health`` stays open for liveness.
    """
    expected = os.environ.get("PLANNER_API_KEY", "")
    if not expected:
        return
    if request.headers.get("X-API-Key") != expected:
        raise HTTPException(
            status_code=401, detail="invalid or missing X-API-Key header"
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    """App factory; tests inject their own settings."""
    app = FastAPI(
        title="Emergency Response Drone Route Planner",
        description="A*/Theta*/visibility-graph route planner over Overture Maps "
        "data (GPS waypoints only).",
        version=__version__,
    )
    # CORS: the website frontend runs on Vercel (including preview/PR
    # domains under *.vercel.app) and calls this service from the browser
    # through the public tunnel URL - without this the requests are blocked.
    # Local dev origins (vite 5173, express 3000) are allowed too.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(http://localhost:\d+|https://[\w-]+\.vercel\.app)$",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # ``from_env_with_no_fly`` so the imported no-fly snapshot (if configured)
    # is loaded once at startup and merged into the planner's static zones.
    settings = settings or Settings.from_env_with_no_fly()
    missions = MissionStore()

    app.state.settings = settings
    app.state.missions = missions
    # Display-only scope list (name/count/age), computed once at startup so
    # /no-fly-zones never re-reads (and re-parses, e.g. the 3.2 MB india
    # snapshot) the files on every request.  Scopes whose snapshot is missing
    # or empty are dropped, so a fresh clone shows only what actually exists.
    scope_info: list[NoFlyZoneScopeInfo] = []
    for name, path in settings.no_fly_zones_files.items():
        snap = load_no_fly_snapshot(path)
        if snap.zones:
            scope_info.append(
                NoFlyZoneScopeInfo(
                    name=name,
                    zones=len(snap.zones),
                    fetched_at=snap.fetched_at,
                )
            )
    app.state.no_fly_scope_info = scope_info

    def _to_route_response(result) -> RouteResponse:
        """Convert a planner RouteResult into the API RouteResponse."""
        return RouteResponse(
            mission_id=result.mission_id,
            distance=result.distance,
            estimated_time=result.estimated_time,
            waypoints=[
                Waypoint(lat=lat, lon=lon, alt=alt)
                for lat, lon, alt in result.waypoints
            ],
            warning=result.warning,
            backup_waypoints=[
                Waypoint(lat=lat, lon=lon, alt=alt)
                for lat, lon, alt in result.backup_waypoints
            ]
            if result.backup_waypoints
            else None,
            zones_crossed=[
                NoFlyZoneInfo(kind=z.kind, name=z.name, ring=list(z.ring))
                for z in result.zones_crossed
            ],
        )

    def _plan_kwargs(req: Any, mission_id: str | None = None) -> dict:
        """Shared planner keyword args derived from a request model."""
        zones = [zone.ring for zone in (req.no_fly_zones or [])]
        grid = req.grid_resolution_m
        if grid is None:
            grid = _default_grid_resolution_m(req)
        return dict(
            start=(req.start_lat, req.start_lon),
            goal=(req.goal_lat, req.goal_lon),
            altitude_m=req.altitude_m,
            grid_resolution_m=grid,
            safety_margin_m=req.safety_margin_m,
            speed_mps=req.speed_mps,
            no_fly_zones=zones,
            snap_start_goal=req.snap_start_goal,
            algorithm=req.algorithm,
            mission_id=mission_id or getattr(req, "mission_id", None),
        )

    def _run_plan(req: Any, mission_id: str | None = None) -> RouteResponse:
        """Shared planning helper; converts planner errors to HTTP errors."""
        planner = RoutePlanner(settings)
        try:
            result = planner.plan(**_plan_kwargs(req, mission_id))
        except NoPathError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except InfeasibleError as exc:
            # client asked for an algorithm that cannot handle this scale
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except PlannerError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        finally:
            planner.close()
        return _to_route_response(result)

    @app.get(
        "/no-fly-zones",
        response_model=NoFlyZonesResponse,
        tags=["ops"],
        dependencies=[Depends(_require_api_key)],
    )
    def no_fly_zones(scope: str = "punjab", bbox: str | None = None) -> NoFlyZonesResponse:
        """The imported DGCA airspace overlay (red/amber rings + snapshot age).

        Reads a local snapshot produced by ``scripts/import_no_fly_zones.py``.
        ``scope`` selects which snapshot to serve (``settings.no_fly_zones_files``,
        e.g. ``punjab`` or ``india``); an empty zone list when the scope is
        unknown or its file is missing.  The default ``punjab`` scope falls
        back to ``settings.no_fly_zones_file`` so existing deployments keep
        working unchanged.

        ``bbox`` optionally restricts the response to zones overlapping
        ``xmin,ymin,xmax,ymax`` (lon, lat) - lets the frontend overlay draw a
        regional view of a full-region snapshot (e.g. the all-india file)
        without shipping thousands of rings to the browser.  Serves the
        frontend map overlay; the planner itself consumes the same rings via
        config (display scope never changes the planner's obstacle set).
        """
        path = settings.no_fly_zones_files.get(scope) or settings.no_fly_zones_file
        snapshot = load_no_fly_snapshot(path)
        zones = snapshot.zones
        if bbox:
            try:
                xmin, ymin, xmax, ymax = (float(v) for v in bbox.split(","))
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail="bbox must be xmin,ymin,xmax,ymax (lon,lat)",
                ) from exc
            zones = filter_zones_by_bbox(zones, (xmin, ymin, xmax, ymax))
        return NoFlyZonesResponse(
            scope=scope,
            fetched_at=snapshot.fetched_at,
            source=snapshot.source,
            zones=[
                NoFlyZoneInfo(kind=z.kind, name=z.name, ring=list(z.ring))
                for z in zones
            ],
            available=app.state.no_fly_scope_info,
        )

    @app.get("/health", response_model=HealthResponse, tags=["ops"])
    def health() -> HealthResponse:
        buildings_ok = os.path.exists(settings.buildings_parquet)
        return HealthResponse(
            status="ok" if buildings_ok else "degraded",
            version=__version__,
            buildings_parquet=settings.buildings_parquet,
            water_parquet=settings.water_parquet,
            memory_limit=settings.memory_limit,
            grid_resolution_m=settings.grid_resolution_m,
            safety_margin_m=settings.safety_margin_m,
            default_altitude_m=settings.default_altitude_m,
            planner_algorithm=settings.planner_algorithm,
        )

    @app.post(
        "/generate-route",
        response_model=RouteResponse,
        tags=["planning"],
        dependencies=[Depends(_require_api_key)],
    )
    def generate_route(req: MissionRequest) -> RouteResponse:
        return _run_plan(req)

    @app.post(
        "/generate-route/stream",
        response_class=StreamingResponse,
        tags=["planning"],
        dependencies=[Depends(_require_api_key)],
        summary="Plan with live progress (NDJSON stream)",
        description=(
            "Same as /generate-route but streams newline-delimited JSON as "
            "the pipeline runs: `stage` events carry partial waypoints "
            "(raw path, then LOS-smoothed, then geometry-refined) plus "
            "region/grid/degraded progress; the final `complete` event "
            "carries the same RouteResponse as /generate-route. Errors are "
            "streamed as `error` events with an HTTP-style status."
        ),
    )
    def generate_route_stream(req: MissionRequest) -> StreamingResponse:
        """Plan as an NDJSON event stream.

        The heavy plan runs in a daemon thread; progress callbacks push
        events into a queue that the response generator drains, so the
        client sees the route take shape instead of waiting for the full
        computation (which can be tens of seconds on degraded city routes).
        Event lines:

        - ``{"type": "stage", "stage": "region"|"grid"|..., **payload}``
        - ``{"type": "stage", "stage": "path"|"smooth"|"geometry",
           "waypoints": [...]}``  - the current best route, draw it live
        - ``{"type": "complete", "data": {RouteResponse}}``
        - ``{"type": "error", "status": ..., "detail": ...}``
        """
        events: queue.Queue = queue.Queue()

        def worker() -> None:
            planner = RoutePlanner(settings)
            try:
                result = planner.plan(
                    **_plan_kwargs(req),
                    progress=lambda event, payload: events.put(
                        {"type": "stage", "stage": event, **payload}
                    ),
                )
                events.put(
                    {"type": "complete", "data": _to_route_response(result).model_dump(mode="json")}
                )
            except NoPathError as exc:
                events.put({"type": "error", "status": 409, "detail": str(exc)})
            except InfeasibleError as exc:
                events.put({"type": "error", "status": 422, "detail": str(exc)})
            except PlannerError as exc:
                events.put({"type": "error", "status": 500, "detail": str(exc)})
            except Exception as exc:  # noqa: BLE001 - never leave the client hanging
                logger.exception("route stream failed unexpectedly")
                events.put(
                    {"type": "error", "status": 500, "detail": "internal server error"}
                )
            finally:
                planner.close()
                events.put(None)  # end-of-stream sentinel

        threading.Thread(target=worker, daemon=True).start()

        async def event_stream():
            while True:
                item = await asyncio.to_thread(events.get)
                if item is None:
                    break
                yield json.dumps(item, default=str) + "\n"

        return StreamingResponse(
            event_stream(),
            media_type="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
        )

    @app.post(
        "/replan",
        response_model=RouteResponse,
        tags=["planning"],
        dependencies=[Depends(_require_api_key)],
    )
    def replan(req: ReplanRequest) -> RouteResponse:
        """Recompute the route from the current position (same semantics as
        generate-route; kept as a separate endpoint so controllers can call
        it mid-mission without re-sending mission metadata)."""
        return _run_plan(req)

    @app.post(
        "/mission",
        response_model=MissionResponse,
        tags=["planning"],
        dependencies=[Depends(_require_api_key)],
    )
    def create_mission(req: MissionCreateRequest) -> MissionResponse:
        mission_id = req.mission_id or f"mission-{uuid.uuid4().hex[:12]}"
        route = _run_plan(req, mission_id=mission_id)
        mission = Mission(
            mission_id=mission_id,
            status="planned",
            request=req.model_dump(mode="json"),
            route=route.model_dump(mode="json"),
        )
        missions.put(mission)
        return MissionResponse(
            mission_id=mission_id, status=mission.status, route=route
        )

    @app.exception_handler(Exception)
    async def _unhandled(_request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error")
        return JSONResponse(status_code=500, content={"detail": "internal server error"})

    return app


app = create_app()
