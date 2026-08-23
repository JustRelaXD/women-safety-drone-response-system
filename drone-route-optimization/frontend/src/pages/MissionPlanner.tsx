import { MissionMap } from "../components/map/MissionMap";
import { MissionStatsPanel } from "../components/mission/MissionStatsPanel";
import { LiveTelemetryPanel } from "../components/mission/LiveTelemetryPanel";
import { MissionControls } from "../components/mission/MissionControls";

export default function MissionPlanner() {
  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[520px] flex-col gap-4 lg:h-[calc(100vh-7.5rem)] lg:flex-row">
      {/* map takes the available space; panels are a fixed-width column */}
      <div className="min-h-[380px] flex-1">
        <MissionMap />
      </div>

      <div className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto lg:w-96">
        <MissionStatsPanel />
        <LiveTelemetryPanel />
        <MissionControls />
      </div>
    </div>
  );
}
