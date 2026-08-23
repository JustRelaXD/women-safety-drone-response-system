import { Link } from "react-router-dom";

import { useBackendHealth } from "../hooks/useBackendHealth";
import { useMissionStore } from "../stores/missionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { Card, CardHeader } from "../components/ui/Card";
import { StatCard } from "../components/ui/StatCard";
import { Badge } from "../components/ui/Feedback";
import { Button } from "../components/ui/Button";
import { ALGORITHM_LABELS, ALGORITHMS, ALGORITHM_DESCRIPTIONS } from "../types";
import { formatDistance, formatDuration } from "../utils/format";

export default function Dashboard() {
  const { health } = useBackendHealth();
  const history = useMissionStore((s) => s.history);
  const algorithm = useSettingsStore((s) => s.algorithm);
  const margin = useSettingsStore((s) => s.safetyMarginM);
  const gridRes = useSettingsStore((s) => s.gridResolutionM);
  const altitude = useSettingsStore((s) => s.altitudeM);
  const last = history[0];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Missions planned"
          value={history.length}
          hint="stored locally on this device"
        />
        <StatCard
          label="Last mission"
          value={last ? formatDistance(last.route.distance) : "-"}
          hint={last ? formatDuration(last.route.estimated_time) : "no missions yet"}
        />
        <StatCard
          label="Waypoints (last)"
          value={last ? last.route.waypoints.length : "-"}
          hint={last ? last.route.mission_id : undefined}
        />
        <StatCard
          label="Planner algorithm"
          value={ALGORITHM_LABELS[algorithm]}
          hint="change in Settings"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Planner backend"
            subtitle="FastAPI + DuckDB Spatial + Overture Maps"
            action={
              <Badge
                tone={
                  health.state === "ok"
                    ? "emerald"
                    : health.state === "offline"
                      ? "rose"
                      : "amber"
                }
              >
                {health.state}
              </Badge>
            }
          />
          <div className="space-y-2 p-4 text-sm text-slate-600 dark:text-slate-300">
            {health.data ? (
              <ul className="space-y-1.5">
                <li>
                  Data: <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">{health.data.buildings_parquet}</code>
                </li>
                <li>Memory cap: {health.data.memory_limit}</li>
                <li>
                  Your settings: grid {gridRes} m / margin {margin} m / altitude{" "}
                  {altitude} m{" "}
                  <span className="text-slate-400 dark:text-slate-500">
                    (sent with each request - update in Settings)
                  </span>
                </li>
                <li className="text-slate-400 dark:text-slate-500">
                  Backend defaults: grid {health.data.grid_resolution_m} m / margin{" "}
                  {health.data.safety_margin_m} m / altitude{" "}
                  {health.data.default_altitude_m} m
                </li>
              </ul>
            ) : (
              <p className="text-rose-600 dark:text-rose-400">
                Backend offline. The planner page still works with demo routes
                and mocked telemetry.
              </p>
            )}
            <div className="pt-2">
              <Link to="/planner">
                <Button variant="primary">Plan a mission</Button>
              </Link>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Pathfinding algorithms" subtitle="Benchmark-justified choice (backend README §7)" />
          <ul className="divide-y divide-slate-200 p-2 dark:divide-slate-800">
            {ALGORITHMS.map((algo) => (
              <li key={algo} className="flex items-start gap-3 px-2 py-2.5">
                <span className="mt-1 flex h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {ALGORITHM_LABELS[algo]}
                    {algo === algorithm && <Badge tone="sky">active</Badge>}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {ALGORITHM_DESCRIPTIONS[algo]}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
