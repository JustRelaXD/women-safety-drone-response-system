import { NavLink } from "react-router-dom";

import { useBackendHealth } from "../../hooks/useBackendHealth";
import { cn } from "../../utils/cn";

const LINKS = [
  { to: "/", label: "Dashboard", icon: <DashboardIcon />, end: true },
  { to: "/planner", label: "Mission Planner", icon: <PlannerIcon /> },
  { to: "/history", label: "Mission History", icon: <HistoryIcon /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon /> },
];

export function Sidebar() {
  const { health } = useBackendHealth();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2.5 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <Logo />
        <div className="leading-tight">
          <div className="text-sm font-bold text-slate-900 dark:text-white">Drone Planner</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">Emergency Response</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {LINKS.map(({ to, label, icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
              )
            }
          >
            {icon}
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-200 px-5 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              health.state === "ok" && "bg-emerald-500",
              health.state === "degraded" && "bg-amber-500",
              health.state === "offline" && "bg-rose-500",
              health.state === "checking" && "bg-slate-400",
            )}
          />
          <span>
            {health.state === "ok"
              ? "Backend online"
              : health.state === "degraded"
                ? "Backend degraded"
                : health.state === "offline"
                  ? "Backend offline (demo mode)"
                  : "Checking backend..."}
          </span>
        </div>
      </div>
    </aside>
  );
}

export function Logo() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2v20M2 12h20" strokeLinecap="round" />
        <circle cx="12" cy="12" r="6" />
      </svg>
    </div>
  );
}

function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function PlannerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3Z" strokeLinejoin="round" />
      <path d="M9 7v13M15 4v13" strokeLinecap="round" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" strokeLinejoin="round" />
    </svg>
  );
}
