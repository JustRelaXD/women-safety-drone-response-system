import { useSettingsStore } from "../stores/settingsStore";
import { Card, CardHeader } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Field, NumberInput } from "../components/ui/Field";
import { cn } from "../utils/cn";
import {
  ALGORITHMS,
  ALGORITHM_DESCRIPTIONS,
  ALGORITHM_LABELS,
  type AlgorithmName,
} from "../types";
import { AUTO_BASEMAP, BASEMAPS, resolveBasemap } from "../utils/basemaps";

export default function SettingsPage() {
  const s = useSettingsStore();

  return (
    <div className="mx-auto grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Planner algorithm"
          subtitle="Sent with every mission request; the backend benchmark default is A*"
        />
        <div className="space-y-2 p-3">
          {ALGORITHMS.map((algo: AlgorithmName) => (
            <button
              key={algo}
              type="button"
              onClick={() => s.setAlgorithm(algo)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                s.algorithm === algo
                  ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                  : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
                  s.algorithm === algo
                    ? "border-emerald-500"
                    : "border-slate-300 dark:border-slate-600",
                )}
              >
                {s.algorithm === algo && (
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                )}
              </span>
              <span>
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                  {ALGORITHM_LABELS[algo]}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {ALGORITHM_DESCRIPTIONS[algo]}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Map layer"
          subtitle="Layers that render building footprints let you verify a route visually"
        />
        <div className="space-y-1 p-3">
          {s.baseMap === AUTO_BASEMAP && (
            <div className="mb-2 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              Auto: currently {resolveBasemap(s.baseMap, s.darkMode).label} (follows your theme).
              Pick a layer below to override.
            </div>
          )}
          {BASEMAPS.map((b) => {
            const active = resolveBasemap(s.baseMap, s.darkMode).id === b.id;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => s.setBaseMap(b.id)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  active
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
                    active
                      ? "border-emerald-500"
                      : "border-slate-300 dark:border-slate-600",
                  )}
                >
                  {active && <span className="h-2 w-2 rounded-full bg-emerald-500" />}
                </span>
                <span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {b.label}
                    </span>
                    {b.showsBuildings && (
                      <span className="rounded bg-emerald-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        buildings
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {b.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Flight & planning" subtitle="Overrides sent with each mission request" />
          <div className="grid grid-cols-2 gap-3 p-4">
            <Field label="Altitude (m)" hint="constant mission altitude">
              <NumberInput
                value={s.altitudeM}
                min={1}
                max={500}
                step={5}
                onChange={(e) => s.setAltitudeM(Number(e.target.value))}
              />
            </Field>
            <Field label="Speed (m/s)" hint="used for the ETA estimate">
              <NumberInput
                value={s.speedMps}
                min={1}
                max={200}
                step={1}
                onChange={(e) => s.setSpeedMps(Number(e.target.value))}
              />
            </Field>
            <Field
              label="Safety margin (m)"
              hint="Clearance from building outlines. 0 m opens the tightest corridors - the grid never plans wider than this."
            >
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={0.5}
                    value={Math.min(s.safetyMarginM, 50)}
                    onChange={(e) => s.setSafetyMarginM(Number(e.target.value))}
                    className="h-1.5 flex-1 cursor-pointer rounded-full bg-slate-200 accent-emerald-500 dark:bg-slate-700"
                    aria-label="Safety margin in metres"
                  />
                  <div className="w-24 shrink-0">
                    <NumberInput
                      value={s.safetyMarginM}
                      min={0}
                      max={200}
                      step={0.5}
                      onChange={(e) => s.setSafetyMarginM(Number(e.target.value))}
                      className="text-center"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[0, 1, 2, 5].map((p) => {
                    const active = Math.abs(s.safetyMarginM - p) < 1e-9;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => s.setSafetyMarginM(p)}
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
                          active
                            ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300"
                            : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800",
                        )}
                      >
                        {p} m
                      </button>
                    );
                  })}
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">
                    0 m = hugging building outlines
                  </span>
                </div>
              </div>
            </Field>
            <Field label="Grid resolution (m)" hint="cell size for grid planners">
              <NumberInput
                value={s.gridResolutionM}
                min={1}
                max={500}
                step={1}
                onChange={(e) => s.setGridResolutionM(Number(e.target.value))}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Appearance" />
          <div className="flex items-center justify-between p-4">
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                Dark mode
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Switches the app UI theme; map tiles are chosen in the Map layer card
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={s.darkMode}
              onClick={() => s.setDarkMode(!s.darkMode)}
              className={cn(
                "relative h-6 w-11 rounded-full transition-colors",
                s.darkMode ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                  s.darkMode ? "left-[22px]" : "left-0.5",
                )}
              />
            </button>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 p-4 pt-3 dark:border-slate-800">
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                No-fly zones overlay
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Show imported DGCA red/amber airspace zones on the mission map
                (from the local snapshot, not live)
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={s.showNoFlyZones}
              onClick={() => s.setShowNoFlyZones(!s.showNoFlyZones)}
              className={cn(
                "relative h-6 w-11 rounded-full transition-colors",
                s.showNoFlyZones ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                  s.showNoFlyZones ? "left-[22px]" : "left-0.5",
                )}
              />
            </button>
          </div>
        </Card>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => s.reset()}>
            Reset all settings
          </Button>
        </div>
      </div>
    </div>
  );
}
