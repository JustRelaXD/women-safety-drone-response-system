"""Emergency-response drone route planner.

Layers:

- ``planner.overture``  - DuckDB Spatial data access over Overture GeoParquet
  (bbox predicate pushdown -> row-group pruning -> ST_Intersects refinement
  -> RTREE-indexed working region). Never loads the full dataset.
- ``planner.core``     - configuration, geometry math, mission bookkeeping.
- ``planner.routing``  - grid rasterization, A* search, path smoothing,
  waypoint generation, and the RoutePlanner facade.
- ``planner.api``      - FastAPI REST layer (GPS waypoints only).
- ``planner.models``   - request/response schemas.
- ``planner.debug``    - diagnostic CLI: overlays straight line / route /
  obstacles / blocked cells in a self-contained Leaflet viewer and explains
  why a route deviates from the straight line.
"""

__version__ = "0.1.0"
