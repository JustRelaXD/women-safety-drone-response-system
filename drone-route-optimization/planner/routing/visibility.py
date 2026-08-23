"""Visibility-graph path planning over polygonal obstacles.

The classical exact-shortest-path algorithm for 2D polygonal environments:
build the graph of mutually visible obstacle vertices (plus start and goal),
then search it with A* (euclidean heuristic).  It is the path-quality gold
standard - the route is the true shortest path around the obstacles.

Two pragmatic adaptations for drone use:

1. Obstacles are first buffered by the safety margin, merged with
   ``unary_union``, and replaced by their **convex hulls**.  For convex
   obstacles the visibility graph is exact, and the hull step keeps the
   vertex count - and therefore the O(V^2) construction cost - tractable.
   The hull over-approximates concave clusters (alleyways inside a cluster
   get blocked): a conservative choice, consistent with the grid
   rasterizer's envelope fast path, and safe for a drone.

2. Construction is O(V^2) candidate visibility tests, so the planner is
   capped (``visibility_max_buildings``, ``visibility_max_vertices``) and
   raises :class:`InfeasibleError` beyond them.  This is deliberate: the
   benchmark shows grid-based planners are the right default for real-time
   replanning; the visibility graph is a small-scope / reference tool.

Visibility test: a segment is blocked iff it properly **crosses** the
interior of any hull (``shapely.crosses``).  Segments that only touch a
hull boundary (grazing a vertex, running along an edge) stay visible - the
classic rule that keeps the graph connected.
"""

from __future__ import annotations

import heapq
import math
import time
from dataclasses import dataclass
from typing import Sequence

import numpy as np
import shapely
from shapely.ops import nearest_points

from ..core.config import Settings
from ..core.exceptions import InfeasibleError
from ..core.geometry import LocalProjection, Point
from .obstacles import ObstacleSource

#: candidate segments per bulk STRtree query batch
_BATCH = 100_000


@dataclass(frozen=True)
class VisibilityPath:
    """A visibility-graph route plus construction statistics."""

    points: tuple[Point, ...]  # (lat, lon) vertices of the shortest path
    vertices_built: int
    edges_built: int
    nodes_explored: int
    build_time_s: float
    search_time_s: float


class VisibilityPlanner:
    """Exact shortest-path planner over convexified obstacle polygons."""

    def __init__(self, config: Settings) -> None:
        self.config = config

    # -- obstacle preprocessing -------------------------------------------
    def _collect_hulls(
        self, sources: Sequence[ObstacleSource], proj: LocalProjection
    ) -> tuple[list, int]:
        """Buffer + merge + convexify every source polygon into local hulls.

        Returns ``(hulls, n_obstacles)`` where ``hulls`` are convex shapely
        polygons in local metre coordinates.  Raises InfeasibleError when the
        obstacle count exceeds the configured cap.
        """
        n_obstacles = sum(int(s.bounds().shape[0]) for s in sources)
        if n_obstacles > self.config.visibility_max_buildings:
            raise InfeasibleError(
                f"visibility graph: {n_obstacles} obstacles exceed the cap of "
                f"{self.config.visibility_max_buildings}; use a grid planner "
                f"(astar / theta_star) at this scale"
            )

        margin = self.config.safety_margin_m
        geoms: list = []
        for source in sources:
            bounds = source.bounds()
            n = bounds.shape[0]
            if n == 0:
                continue
            for g in source.fetch(np.arange(n)):
                if g is None or g.is_empty:
                    continue
                local = shapely.affinity.affine_transform(g, proj.affine_transform())
                if margin:
                    # quad_segs=2 keeps the buffer outline cheap (rounded
                    # corners with 2 segments per quadrant)
                    local = local.buffer(margin, quad_segs=2)
                geoms.append(local)

        if not geoms:
            return [], n_obstacles
        union = shapely.unary_union(geoms)
        if union.is_empty:
            return [], n_obstacles
        parts = [union] if union.geom_type == "Polygon" else list(union.geoms)
        hulls = [p.convex_hull for p in parts if not p.convex_hull.is_empty]
        # simplify rounded corners within the safety margin: the chord error
        # (<= margin * 10 %) is absorbed by the margin itself, and it keeps
        # the vertex count - and the O(V^2) construction - tractable
        tol = max(0.05, margin * 0.1)
        if tol:
            hulls = [h.simplify(tol, preserve_topology=True) for h in hulls]
        # drop slivers (e.g. collinear leftovers of the hull step)
        hulls = [h for h in hulls if h.area > 0.25]
        return hulls, n_obstacles

    def _vertex_list(self, hulls: Sequence) -> tuple[list[tuple[float, float]], np.ndarray]:
        """Deduped obstacle vertices, enforcing the vertex cap."""
        verts: list[tuple[float, float]] = []
        seen: set[tuple[float, float]] = set()
        for hull in hulls:
            for x, y in hull.exterior.coords[:-1]:
                key = (round(x, 4), round(y, 4))
                if key not in seen:
                    seen.add(key)
                    verts.append((x, y))
        if len(verts) > self.config.visibility_max_vertices:
            raise InfeasibleError(
                f"visibility graph: {len(verts)} obstacle vertices exceed the cap "
                f"of {self.config.visibility_max_vertices}; use a grid planner at "
                f"this scale"
            )
        return verts, np.asarray(verts, dtype=np.float64)

    @staticmethod
    def _snap(pt, hulls: Sequence) -> tuple[float, float]:
        """Nearest point on the nearest hull boundary (start/goal snapping)."""
        dists = shapely.distance(np.asarray(hulls, dtype=object), pt)
        k = int(np.argmin(dists))
        _, nearest = nearest_points(pt, hulls[k])
        return (nearest.x, nearest.y)

    # -- edge construction --------------------------------------------------
    def _build_visibility_edges(
        self,
        verts: list[tuple[float, float]],
        node_xy: np.ndarray,
        hulls: np.ndarray,
        hulls_tree,
    ) -> list[set[int]]:
        """Adjacency list of mutually visible vertex pairs (i < j only)."""
        v = len(verts)
        adj: list[set[int]] = [set() for _ in range(v)]
        batch: list[tuple[int, int]] = []
        coords: list[tuple[float, float]] = []
        for a in range(v):
            for b in range(a + 1, v):
                batch.append((a, b))
                coords.append((node_xy[a], node_xy[b]))
                if len(batch) >= _BATCH:
                    self._consume_batch(batch, coords, adj, hulls, hulls_tree)
                    batch = []
                    coords = []
        if batch:
            self._consume_batch(batch, coords, adj, hulls, hulls_tree)
        return adj

    @staticmethod
    def _consume_batch(
        batch: list[tuple[int, int]],
        coords: list[tuple[float, float]],
        adj: list[set[int]],
        hulls: np.ndarray,
        hulls_tree,
    ) -> None:
        segs = shapely.linestrings(np.asarray(coords, dtype=np.float64))
        geom_idx, tree_idx = hulls_tree.query(segs)  # candidate (seg, hull) pairs
        blocked = np.zeros(len(batch), dtype=bool)
        if geom_idx.size:
            blocked[geom_idx[shapely.crosses(segs[geom_idx], hulls[tree_idx])]] = True
        for k, (a, b) in enumerate(batch):
            if not blocked[k]:
                adj[a].add(b)
                adj[b].add(a)

    # -- graph search --------------------------------------------------------
    @staticmethod
    def _astar_on_graph(
        adj: list[set[int]], node_xy: np.ndarray, start_idx: int, goal_idx: int
    ) -> tuple[list[int], int] | None:
        """A* over the visibility graph; returns (vertex path, nodes closed)."""
        v = node_xy.shape[0]
        dist = np.full(v, np.inf)
        prev = np.full(v, -1, dtype=np.int64)
        closed = np.zeros(v, dtype=bool)
        dist[start_idx] = 0.0
        gx, gy = node_xy[goal_idx]

        def h(i: int) -> float:
            return math.hypot(node_xy[i, 0] - gx, node_xy[i, 1] - gy)

        heap: list[tuple[float, int, int]] = [(h(start_idx), 0, start_idx)]
        counter = 1
        while heap:
            f, _, u = heapq.heappop(heap)
            if closed[u]:
                continue
            closed[u] = True
            if u == goal_idx:
                path: list[int] = []
                cur = u
                while cur != -1:
                    path.append(int(cur))
                    if cur == start_idx:
                        break
                    cur = prev[cur]
                path.reverse()
                return path, int(closed.sum())
            du = dist[u]
            ux, uy = node_xy[u]
            for v_nb in adj[u]:
                if closed[v_nb]:
                    continue
                nd = du + math.hypot(node_xy[v_nb, 0] - ux, node_xy[v_nb, 1] - uy)
                if nd < dist[v_nb]:
                    dist[v_nb] = nd
                    prev[v_nb] = u
                    heapq.heappush(heap, (nd + h(v_nb), counter, v_nb))
                    counter += 1
        return None

    # -- entry point ----------------------------------------------------------
    def find_path(
        self,
        sources: Sequence[ObstacleSource],
        proj: LocalProjection,
        start: Point,
        goal: Point,
        *,
        snap: bool = False,
    ) -> VisibilityPath | None:
        """Shortest path around the source obstacles, or None if unreachable.

        With ``snap=True`` a start/goal that falls inside an obstacle is moved
        to the nearest point on the obstacle boundary (useful for imprecise
        controller GPS; off by default so planning stays strict).
        """
        t_build0 = time.perf_counter()
        hulls, _ = self._collect_hulls(sources, proj)
        s_xy = proj.to_local(*start)
        g_xy = proj.to_local(*goal)

        if not hulls:
            # empty free space: the straight line is optimal
            return VisibilityPath(
                points=(start, goal), vertices_built=2, edges_built=1,
                nodes_explored=1, build_time_s=0.0, search_time_s=0.0,
            )

        hulls_arr = np.asarray(hulls, dtype=object)
        hulls_tree = shapely.STRtree(hulls_arr)
        s_pt = shapely.geometry.Point(s_xy)
        g_pt = shapely.geometry.Point(g_xy)

        if bool(shapely.contains(hulls_arr, s_pt).any()) or bool(
            shapely.contains(hulls_arr, g_pt).any()
        ):
            if not snap:
                return None
            if shapely.contains(hulls_arr, s_pt).any():
                s_xy = self._snap(s_pt, hulls)
            if shapely.contains(hulls_arr, g_pt).any():
                g_xy = self._snap(g_pt, hulls)
            s_pt = shapely.geometry.Point(s_xy)
            g_pt = shapely.geometry.Point(g_xy)

        verts, base_xy = self._vertex_list(hulls)
        node_xy = np.vstack([base_xy, [s_xy], [g_xy]])
        s_idx, g_idx = len(verts), len(verts) + 1

        adj = self._build_visibility_edges(list(map(tuple, node_xy.tolist())),
                                           node_xy, hulls_arr, hulls_tree)
        build_time = time.perf_counter() - t_build0

        t_search0 = time.perf_counter()
        found = self._astar_on_graph(adj, node_xy, s_idx, g_idx)
        search_time = time.perf_counter() - t_search0
        if found is None:
            return None
        path_idx, nodes_closed = found

        points = tuple(
            proj.to_geo(float(node_xy[i, 0]), float(node_xy[i, 1]))
            for i in path_idx
        )
        n_edges = sum(len(a) for a in adj) // 2
        return VisibilityPath(
            points=points,
            vertices_built=int(node_xy.shape[0]),
            edges_built=n_edges,
            nodes_explored=nodes_closed,
            build_time_s=round(build_time, 4),
            search_time_s=round(search_time, 4),
        )
