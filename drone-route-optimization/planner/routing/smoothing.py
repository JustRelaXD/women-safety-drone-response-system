"""Greedy line-of-sight path smoothing.

Two stages, both greedy and both safe for a drone:

1. :func:`smooth_path` - cell-level LOS smoothing over the grid.  Shortens
   an A* path by replacing visible intermediate cells with straight
   segments.  ``has_line_of_sight`` uses a conservative thick-line test: for
   multi-step diagonal segments it also checks the two orthogonally adjacent
   cells, so the smoothed path never cuts the corner of a diagonally-adjacent
   pair of blocked cells - important for a drone with a physical footprint.
   Single diagonal steps (n == 1) skip the corner test: the search already
   validated that move, and a corner test there would reject perfectly legal
   steps.  The smoothing loop is guaranteed to make progress even if a path
   node itself is blocked (defensive, e.g. against pathological inputs).

2. :func:`smooth_path_geometry` - geometry-exact shortcut pass over the
   result.  The grid over-blocks (buffered envelopes of small buildings
   block whole cells), so the cell-level path still zigzags through open
   fields.  This pass tests every candidate shortcut against the ACTUAL
   obstacle polygons (buffered by the safety margin) instead of the
   rasterized cells, so it can straighten through over-blocked areas while
   never approaching a real obstacle closer than the margin.
"""

from __future__ import annotations

import logging
from typing import Sequence

import numpy as np
import shapely
from shapely.geometry.base import BaseGeometry

from .grid import GeoGrid

logger = logging.getLogger(__name__)

Cell = tuple[int, int]
LocalPoint = tuple[float, float]


def has_line_of_sight(grid: GeoGrid, a: Cell, b: Cell) -> bool:
    """True when every cell crossed by the segment a->b is flyable."""
    x0, y0 = a
    x1, y1 = b
    dx, dy = x1 - x0, y1 - y0
    n = max(abs(dx), abs(dy))
    if n == 0:
        return True
    blocked = grid.blocked
    w, h = grid.width, grid.height
    for k in range(1, n + 1):
        i = x0 + round(dx * k / n)
        j = y0 + round(dy * k / n)
        if blocked[j, i]:
            return False
        if dx and dy and n > 1:
            # corner-safety: check the two orthogonal neighbours too (the
            # line clips their corner); guard against the grid edges
            js = j - (1 if dy > 0 else -1)
            is_ = i - (1 if dx > 0 else -1)
            if (0 <= js < h and blocked[js, i]) or (0 <= is_ < w and blocked[j, is_]):
                return False
    return True


def smooth_path(grid: GeoGrid, path: list[Cell]) -> list[Cell]:
    """Greedy smoothing: keep the furthest visible cell, jump to it, repeat.

    Always keeps the endpoints and guarantees progress, so it cannot loop.
    """
    if len(path) <= 2:
        return list(path)
    out: list[Cell] = [path[0]]
    i = 0
    while i < len(path) - 1:
        j = i + 1
        while j < len(path) and has_line_of_sight(grid, path[i], path[j]):
            j += 1
        if j == i + 1:
            # even the immediate neighbour fails LOS; keep it (it is part of
            # the search path) unless it is itself blocked, and move on
            nxt = path[i + 1]
            if not grid.blocked[nxt[1], nxt[0]]:
                out.append(nxt)
            i += 1
        else:
            out.append(path[j - 1])
            i = j - 1
    return out


def _segment_clear(
    tree: shapely.STRtree,
    geoms: Sequence[BaseGeometry],
    a: LocalPoint,
    b: LocalPoint,
    margin_m: float,
) -> bool:
    """True when the segment a->b keeps >= ``margin_m`` from every geometry."""
    line = shapely.LineString([a, b])
    # predicate='dwithin' prunes candidates inside the tree (prepared
    # distance tests), which is orders of magnitude faster than buffering the
    # line and looping over every envelope candidate in Python - important in
    # dense regions where tens of thousands of buildings sit near the route
    return len(tree.query(line, predicate="dwithin", distance=margin_m)) == 0


def smooth_path_geometry(
    points_local: Sequence[LocalPoint],
    geoms_local: Sequence[BaseGeometry],
    margin_m: float,
) -> list[LocalPoint]:
    """Greedy shortcut of a polyline against real obstacle geometries.

    Works entirely in a shared local metre frame (both the points and the
    geometries must be in the same frame - typically the equirectangular
    mission projection, which keeps distances in metres).  From each kept
    vertex it jumps to the furthest later vertex whose straight segment is at
    least ``margin_m`` from every geometry; the endpoints are always kept.

    This is the geometry-exact counterpart of :func:`smooth_path`: it may
    shortcut through cells the grid over-blocks (envelope rasterization), but
    every segment it *keeps* is validated to stay at least ``margin_m`` from
    every geometry.  With no geometries it collapses to [first, last].

    Guarantee: the result is a subsequence of the input (endpoints always
    kept) in which every straight segment that skips input vertices was
    tested clear.  The only segments not re-tested are consecutive input
    vertices kept unchanged in the pathological forced-progress case (when
    even the immediate successor fails the margin test); the caller is
    expected to feed an already-safe polyline (the grid pipeline does - its
    cells are blocked out to the same margin), and such a case is flagged
    with a warning instead of silently producing an unsafe shortcut.
    """
    if len(points_local) <= 2:
        return list(points_local)
    if len(geoms_local) == 0:
        return [points_local[0], points_local[-1]]
    tree = shapely.STRtree(geoms_local)
    out: list[LocalPoint] = [points_local[0]]
    i = 0
    while i < len(points_local) - 1:
        # extend the jump WHILE it stays clear (same pattern as the cell
        # smoother): keeps the furthest clear prefix.  In dense terrain this
        # costs a handful of short, cheap tree queries per step instead of
        # probing every long failing segment (which is O(n^2) expensive
        # tree queries over 20 km lines).
        j = i + 1
        last_clear = i + 1
        extended = False
        while j < len(points_local) and _segment_clear(
            tree, geoms_local, points_local[i], points_local[j], margin_m
        ):
            extended = True
            last_clear = j
            j += 1
        if not extended:
            # forced progress: even the immediate successor failed the margin
            # test, so it is kept unchanged (dropping it would jump over an
            # even longer, unvalidated segment).  This is only reachable when
            # the caller's polyline itself violates the margin - the grid
            # pipeline's conservative blocked cells prevent it - so warn
            # rather than silently emitting a potentially unsafe segment.
            logger.warning(
                "geometry smoothing: forced progress at vertex %d - the input "
                "polyline itself is closer than %.1f m to an obstacle",
                i, margin_m,
            )
        out.append(points_local[last_clear])
        i = last_clear
    return out
