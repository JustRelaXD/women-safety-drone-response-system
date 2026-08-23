import { useCallback } from "react";

import { useMissionStore } from "../../stores/missionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTelemetryStore } from "../../stores/telemetryStore";
import { Card, CardHeader } from "../ui/Card";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/Feedback";

export function MissionControls() {
  const start = useMissionStore((s) => s.start);
  const goal = useMissionStore((s) => s.goal);
  const route = useMissionStore((s) => s.route);
  const status = useMissionStore((s) => s.status);
  const error = useMissionStore((s) => s.error);
  const usedDemo = useMissionStore((s) => s.usedDemo);
  const missionStatus = useTelemetryStore((s) => s.status);

  const hasRoute = route !== null;
  const inFlight = missionStatus === "in-flight";
  const paused = missionStatus === "paused";
  const missionActive = inFlight || paused;

  const generate = useCallback(() => {
    const settings = useSettingsStore.getState();
    useTelemetryStore.getState().reset();
    void useMissionStore.getState().generateRoute(settings);
  }, []);

  const loadDemo = useCallback(() => {
    useTelemetryStore.getState().reset();
    useMissionStore.getState().loadDemo();
  }, []);

  const startMission = useCallback(() => {
    const s = useMissionStore.getState();
    const settings = useSettingsStore.getState();
    if (!s.route) return;
    useTelemetryStore.getState().start(s.route.waypoints, settings.speedMps);
    void s.registerMission(settings); // best-effort persistence to backend
  }, []);

  const replan = useCallback(() => {
    const s = useMissionStore.getState();
    const settings = useSettingsStore.getState();
    const t = useTelemetryStore.getState().telemetry;
    const from = t ? { lat: t.lat, lon: t.lon } : s.start;
    if (!from) return;
    void s.replan(from, settings);
  }, []);

  return (
    <Card>
      <CardHeader title="Mission controls" subtitle="Backend calls with graceful demo fallback" />
      <div className="space-y-3 p-3">
        {status === "error" && error ? (
          <ErrorBanner message={error}>
            <Button size="sm" variant="primary" onClick={generate}>
              Retry
            </Button>
            {!usedDemo && (
              <Button size="sm" variant="secondary" onClick={loadDemo}>
                Load demo route
              </Button>
            )}
          </ErrorBanner>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => generate()}
            loading={status === "loading"}
            disabled={!start || !goal}
          >
            Generate Route
          </Button>
          <Button variant="secondary" onClick={loadDemo} disabled={!start || !goal}>
            Demo route
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <Button
            variant="secondary"
            onClick={startMission}
            disabled={!hasRoute || missionActive}
          >
            Start Mission
          </Button>
          {missionActive ? (
            <Button
              variant="secondary"
              onClick={() => useTelemetryStore.getState().pause()}
              disabled={paused}
            >
              Pause
            </Button>
          ) : null}
          {paused ? (
            <Button
              variant="secondary"
              onClick={() => useTelemetryStore.getState().resume()}
            >
              Resume
            </Button>
          ) : null}
          <Button
            variant="danger"
            onClick={() => useTelemetryStore.getState().abort()}
            disabled={!missionActive}
          >
            Abort
          </Button>
          <Button variant="ghost" onClick={replan} disabled={!hasRoute}>
            Replan from drone
          </Button>
        </div>

        {usedDemo && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            The backend was unreachable, so a demo route is shown. Start the
            Python service and press Generate Route for a real plan.
          </p>
        )}
      </div>
    </Card>
  );
}
