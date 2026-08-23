import { useTelemetryStore } from "../../stores/telemetryStore";
import { useMissionStore } from "../../stores/missionStore";
import { Card, CardHeader } from "../ui/Card";
import { Badge } from "../ui/Feedback";
import { StatCard } from "../ui/StatCard";
import {
  formatDistance,
  formatHeading,
  formatLatLon,
} from "../../utils/format";
import type { MissionStatus } from "../../services/telemetry";

const STATUS_BADGE: Record<MissionStatus, { label: string; tone: "emerald" | "amber" | "rose" | "slate" | "sky" }> = {
  idle: { label: "Idle", tone: "slate" },
  "in-flight": { label: "In flight", tone: "emerald" },
  paused: { label: "Paused", tone: "amber" },
  aborted: { label: "Aborted", tone: "rose" },
  completed: { label: "Completed", tone: "sky" },
};

export function LiveTelemetryPanel() {
  const status = useTelemetryStore((s) => s.status);
  const telemetry = useTelemetryStore((s) => s.telemetry);
  const waypointCount = useMissionStore((s) => s.route?.waypoints.length ?? 0);

  const badge = STATUS_BADGE[status];

  return (
    <Card>
      <CardHeader
        title="Live mission"
        subtitle="Mock telemetry - ready for a real controller feed"
        action={<Badge tone={badge.tone}>{badge.label}</Badge>}
      />
      <div className="p-3">
        {!telemetry ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Press <span className="font-medium text-slate-700 dark:text-slate-200">Start Mission</span> to
            stream mocked drone telemetry along the route.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span>Battery</span>
                <span className="tabular-nums">{telemetry.batteryPct.toFixed(0)} %</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className={`h-full rounded-full transition-[width] ${
                    telemetry.batteryPct > 30 ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                  style={{ width: `${telemetry.batteryPct}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Altitude" value={`${telemetry.alt.toFixed(0)} m`} />
              <StatCard label="Speed" value={`${telemetry.speedMps.toFixed(1)} m/s`} />
              <StatCard label="Heading" value={formatHeading(telemetry.headingDeg)} />
              <StatCard
                label="Waypoint"
                value={`${telemetry.waypointIndex}/${waypointCount}`}
              />
              <StatCard
                label="Flown"
                value={formatDistance(telemetry.distanceFlownM)}
              />
              <StatCard
                label="Position"
                value={formatLatLon(telemetry.lat, telemetry.lon, 4)}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span>Route progress</span>
                <span className="tabular-nums">{telemetry.progressPct.toFixed(0)} %</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className="h-full rounded-full bg-sky-500 transition-[width]"
                  style={{ width: `${telemetry.progressPct}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
