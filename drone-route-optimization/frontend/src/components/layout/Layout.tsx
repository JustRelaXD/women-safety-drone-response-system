import { NavLink, Outlet, useLocation } from "react-router-dom";

import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { cn } from "../../utils/cn";

const MOBILE_LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/planner", label: "Planner" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
];

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar path={pathname} />

        <main className="flex-1 overflow-x-hidden px-4 py-5 lg:px-6">
          <Outlet />
        </main>

        {/* mobile bottom navigation */}
        <nav className="sticky bottom-0 z-20 grid grid-cols-4 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-900/95">
          {MOBILE_LINKS.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium",
                  isActive
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-slate-500 dark:text-slate-400",
                )
              }
            >
              <LogoMark />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2v20M2 12h20" strokeLinecap="round" />
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}
