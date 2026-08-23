import { useMissionStore } from "../../stores/missionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Card, CardHeader } from "../ui/Card";
import { StatCard } from "../ui/StatCard";
import { Spinner, Badge } from "../ui/Feedback";
import { ALGORITHM_LABELS } from "../../types";
import { formatDistance, formatDuration } from "../../utils/format";

/**
 * Amber-zone crossing notice: the route passes through controlled airspace
 * that is PASSABLE with prior permission.  The operator must request the
 * clearance and notify the airport authority before launch.  Red zones on a
 * route are a hard safety violation (only possible on a degraded route) and
 * get the strongest wording.
 */
function AmberCrossingNotice() {
  const route = useMissionStore((s) => s.route);
  const zones = route?.zones_crossed ?? [];
  if (zones.length === 0) return null;

  const amber = zones.filter((z) => z.kind !== "red");
  const red = zones.filter((z) => z.kind === "red");
  const names = zones.map((z) => z.name).filter(Boolean);
  const zoneLabel = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ") || "unnamed zone";

  if (red.length > 0) {
    return (
      <div className="mx-3 mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm leading-snug text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
        <div className="flex items-start gap-2">
          <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <p className="min-w-0">
            Route crosses <b>{red.length} prohibited red zone{red.length > 1 ? "s" : ""}</b>{" "}
            ({zoneLabel}) - DO NOT FLY. This only happens on a degraded route; pick a
            different destination.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-snug text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
        <p className="min-w-0">
          Route crosses <b>{amber.length} amber zone{amber.length > 1 ? "s" : ""}</b>{" "}
          ({zoneLabel}) - passable <b>with prior permission</b>. Request clearance and{" "}
          <b>notify the airport authority</b> before launch.
        </p>
      </div>
    </div>
  );
}

export function MissionStatsPanel() {
  const route = useMissionStore((s) => s.route);
  const status = useMissionStore((s) => s.status);
  const usedDemo = useMissionStore((s) => s.usedDemo);
  const missionId = useMissionStore((s) => s.missionId);
  const stageMessage = useMissionStore((s) => s.stageMessage);
  const partialCount = useMissionStore((s) => s.partialWaypoints.length);
  const algorithm = useSettingsStore((s) => s.algorithm);
  const margin = useSettingsStore((s) => s.safetyMarginM);
  const gridRes = useSettingsStore((s) => s.gridResolutionM);

  if (status === "loading") {
    return (
      <Card>
        <CardHeader title="Mission statistics" />
        <div className="space-y-2 p-4">
          <Spinner label={stageMessage ?? "Planning route with the backend..."} />
          {partialCount > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {partialCount} waypoints drawn so far - the route refines as the
              backend finishes smoothing.
            </p>
          )}
        </div>
      </Card>
    );
  }

  if (!route) {
    return (
      <Card>
        <CardHeader title="Mission statistics" />
        <div className="p-4 text-sm text-slate-500 dark:text-slate-400">
          Place a start and a destination on the map, then press{" "}
          <span className="font-medium text-slate-700 dark:text-slate-200">
            Generate Route
          </span>
          . Statistics will appear here.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Mission statistics"
        subtitle={missionId ?? undefined}
        action={
          <div className="flex items-center gap-2">
            {usedDemo && <Badge tone="amber">demo route</Badge>}
            {route.warning ? <Badge tone="amber">degraded</Badge> : <Badge tone="emerald">{ALGORITHM_LABELS[algorithm]}</Badge>}
          </div>
        }
      />
      {route.warning ? (
        <div className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-snug text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <p className="min-w-0">{route.warning}</p>
          </div>
        </div>
      ) : null}
      <AmberCrossingNotice />
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Distance" value={formatDistance(route.distance)} />
        <StatCard
          label="Est. flight time"
          value={formatDuration(route.estimated_time)}
        />
        <StatCard label="Waypoints" value={route.waypoints.length} />
        <StatCard label="Altitude" value={`${route.waypoints[0]?.alt ?? "-"} m`} />
        <StatCard
          label="Clearance"
          value={`${margin} m`}
          hint="safety margin sent with this request"
        />
        <StatCard label="Grid" value={`${gridRes} m`} hint="cell size sent with this request" />
      </div>
    </Card>
  );
}
