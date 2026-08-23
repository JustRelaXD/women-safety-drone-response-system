import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Layout } from "./components/layout/Layout";
import Dashboard from "./pages/Dashboard";
import MissionPlanner from "./pages/MissionPlanner";
import MissionHistory from "./pages/MissionHistory";
import SettingsPage from "./pages/SettingsPage";
import { useSettingsStore } from "./stores/settingsStore";
import { useTelemetryLoop } from "./hooks/useTelemetryLoop";

export default function App() {
  const darkMode = useSettingsStore((s) => s.darkMode);
  useTelemetryLoop();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="planner" element={<MissionPlanner />} />
          <Route path="history" element={<MissionHistory />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
