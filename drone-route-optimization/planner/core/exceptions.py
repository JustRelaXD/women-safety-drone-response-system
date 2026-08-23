"""Planner exception hierarchy."""


class PlannerError(Exception):
    """Base class for all planner errors."""


class NoPathError(PlannerError):
    """A* could not find a path between the requested points."""

    def __init__(self, message: str = "no collision-free path found") -> None:
        super().__init__(message)


class RegionLoadError(PlannerError):
    """The working region could not be materialised from the GeoParquet."""


class DataUnavailableError(PlannerError):
    """A configured data source (e.g. water) is missing or unreadable."""


class InfeasibleError(PlannerError):
    """An algorithm cannot handle this problem scale or geometry.

    Raised by the visibility-graph planner when the working region exceeds
    its construction caps (obstacle count / vertex count) - not a "no path"
    condition, but "wrong tool for this scale".
    """
