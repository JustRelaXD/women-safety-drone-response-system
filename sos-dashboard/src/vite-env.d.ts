/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  /** Public URL of the drone route planner backend (overture-test) on the
   *  VPS, published via the outbound tunnel (e.g. https://<hash>.proxy.netbird.io). */
  readonly VITE_PLANNER_API_URL?: string;
  /** Optional shared secret sent as X-API-Key when the backend enforces it. */
  readonly VITE_PLANNER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
