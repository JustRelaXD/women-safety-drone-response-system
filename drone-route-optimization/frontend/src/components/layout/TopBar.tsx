import { useSettingsStore } from "../../stores/settingsStore";
import { useBackendHealth } from "../../hooks/useBackendHealth";
import { cn } from "../../utils/cn";

const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/planner": "Mission Planner",
  "/history": "Mission History",
  "/settings": "Settings",
};

export function TopBar({ path }: { path: string }) {
  const darkMode = useSettingsStore((s) => s.darkMode);
  const setDarkMode = useSettingsStore((s) => s.setDarkMode);
  const { health } = useBackendHealth();

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:px-6 dark:border-slate-800 dark:bg-slate-900/90">
      <h1 className="text-base font-semibold text-slate-900 lg:text-lg dark:text-white">
        {TITLES[path] ?? "Drone Planner"}
      </h1>

      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium sm:inline-flex",
            health.state === "ok" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
            health.state === "degraded" && "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
            health.state === "offline" && "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
            health.state === "checking" && "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              health.state === "ok" && "bg-emerald-500",
              health.state === "degraded" && "bg-amber-500",
              health.state === "offline" && "bg-rose-500",
              health.state === "checking" && "animate-pulse bg-slate-400",
            )}
          />
          {health.state === "ok"
            ? "API online"
            : health.state === "offline"
              ? "API offline"
              : health.state === "degraded"
                ? "API degraded"
                : "checking API"}
        </span>

        <button
          type="button"
          onClick={() => setDarkMode(!darkMode)}
          aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {darkMode ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
