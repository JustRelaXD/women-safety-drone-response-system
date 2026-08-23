"""Config sanity tests."""

from planner.core.config import Settings


def test_defaults_are_sane():
    s = Settings()
    assert s.grid_resolution_m > 0
    assert s.safety_margin_m >= 0
    assert s.default_altitude_m > 0
    assert s.max_grid_cells > 0
    assert s.memory_limit.endswith("MB") or s.memory_limit.endswith("GB")
    assert s.threads >= 1
    assert s.water_parquet is None


def test_from_env_overrides(monkeypatch):
    monkeypatch.setenv("PLANNER_GRID_RESOLUTION_M", "25")
    monkeypatch.setenv("PLANNER_MEMORY_LIMIT", "128MB")
    monkeypatch.setenv("PLANNER_WATER_PARQUET", "/x/water.parquet")
    monkeypatch.setenv("PLANNER_POLYGON_BUFFER_M", "3")
    monkeypatch.setenv("PLANNER_RASTERIZE_EXACT_POLYGONS", "0")
    s = Settings.from_env()
    assert s.grid_resolution_m == 25.0
    assert s.memory_limit == "128MB"
    assert s.water_parquet == "/x/water.parquet"
    assert s.polygon_buffer_m == 3.0
    assert s.rasterize_exact_polygons is False


def test_algorithm_default_and_env(monkeypatch):
    assert Settings().planner_algorithm == "astar"
    assert Settings().visibility_max_buildings > 0
    assert Settings().visibility_max_vertices > 0
    monkeypatch.setenv("PLANNER_ALGORITHM", "theta_star")
    assert Settings.from_env().planner_algorithm == "theta_star"
    monkeypatch.setenv("PLANNER_ALGORITHM", "bogus")
    assert Settings.from_env().planner_algorithm == "astar"


def test_frozen():
    s = Settings()
    try:
        s.grid_resolution_m = 99.0  # type: ignore[misc]
    except Exception:
        pass
    else:
        raise AssertionError("Settings must be immutable")
