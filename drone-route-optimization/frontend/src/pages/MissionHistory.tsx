import { useNavigate } from "react-router-dom";

import { useMissionStore } from "../stores/missionStore";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Feedback";
import { formatDistance, formatDuration, formatTimestamp } from "../utils/format";

export default function MissionHistory() {
  const history = useMissionStore((s) => s.history);
  const loadFromHistory = useMissionStore((s) => s.loadFromHistory);
  const removeFromHistory = useMissionStore((s) => s.removeFromHistory);
  const navigate = useNavigate();

  if (history.length === 0) {
    return (
      <Card className="mx-auto max-w-3xl p-8 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No missions yet. Plan one in the{" "}
          <span className="font-medium text-slate-700 dark:text-slate-200">
            Mission Planner
          </span>{" "}
          and press Start Mission - it is registered here automatically.
        </p>
        <div className="mt-4">
          <Button variant="primary" onClick={() => navigate("/planner")}>
            Go to planner
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {history.map((m) => (
        <Card key={m.mission_id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-slate-800 dark:text-slate-100">
                  {m.mission_id}
                </span>
                <Badge tone="emerald">{m.request.algorithm ?? "astar"}</Badge>
                {m.route.waypoints.length > 20 && (
                  <Badge tone="slate">{m.route.waypoints.length} waypoints</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {formatTimestamp(m.created_at)} · {formatDistance(m.route.distance)} ·{" "}
                {formatDuration(m.route.estimated_time)} ETA
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  loadFromHistory(m);
                  navigate("/planner");
                }}
              >
                Load
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => removeFromHistory(m.mission_id)}
              >
                Delete
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
