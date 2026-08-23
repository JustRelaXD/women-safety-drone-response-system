/**
 * Basemap registry.
 *
 * Several layers here render building footprints as visible polygons
 * (flagged `showsBuildings`) or real satellite imagery, so a mission route
 * can be eyeballed against actual building outlines before dispatch.
 * All are public tile services that need nothing but a URL and attribution.
 *
 * Every layer in this list was verified to return real tiles for the
 * Punjab region.  (tile.openstreetmap.fr was excluded: it returns 404 from
 * cloud IP ranges, so HOT/OSM France styles were not shipped.)
 *
 * The persisted setting can also be the special value `"auto"`, which picks
 * the themed default (dark tiles in dark mode, Voyager otherwise).
 */

export type BasemapId =
  | "imagery"
  | "esri-streets"
  | "osm-de"
  | "osm"
  | "voyager"
  | "dark";

/** The persisted value: a concrete basemap or `"auto"` (themed default). */
export type BaseMapSetting = BasemapId | "auto";

export interface Basemap {
  id: BasemapId;
  label: string;
  description: string;
  url: string;
  attribution: string;
  subdomains?: string;
  maxZoom: number;
  maxNativeZoom?: number;
  /** Renders building footprints as visible polygons (or real roofs). */
  showsBuildings: boolean;
  /** Dark-styled tiles (used by the `"auto"` default in dark mode). */
  dark: boolean;
}

export const AUTO_BASEMAP = "auto";

export const BASEMAPS: Basemap[] = [
  {
    id: "imagery",
    label: "Satellite (Esri)",
    description:
      "Real satellite imagery - see actual roofs, the ground truth for route verification.",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri | Source: Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
    maxNativeZoom: 19,
    showsBuildings: true,
    dark: false,
  },
  {
    id: "esri-streets",
    label: "Streets (Esri)",
    description:
      "Esri World Street Map - urban building footprints rendered as polygons.",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri",
    maxZoom: 19,
    maxNativeZoom: 19,
    showsBuildings: true,
    dark: false,
  },
  {
    id: "osm-de",
    label: "Buildings (OSM.de)",
    description:
      "OpenStreetMap render with clear building footprints - zoom in to inspect.",
    url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    maxNativeZoom: 19,
    showsBuildings: true,
    dark: false,
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    description:
      "Standard OSM tiles; building footprints appear as polygons once zoomed in (zoom 16+).",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    maxNativeZoom: 19,
    showsBuildings: true,
    dark: false,
  },
  {
    id: "voyager",
    label: "Voyager (light)",
    description: "Clean light basemap; subtle building footprints.",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20,
    showsBuildings: false,
    dark: false,
  },
  {
    id: "dark",
    label: "Dark (Carto)",
    description: "Dark basemap matching the app theme; buildings not visible.",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20,
    showsBuildings: false,
    dark: true,
  },
];

const BY_ID = new Map(BASEMAPS.map((b) => [b.id, b]));

/** Resolves the persisted setting (which may be `"auto"`) to a concrete basemap. */
export function resolveBasemap(
  setting: BaseMapSetting,
  darkMode: boolean,
): Basemap {
  if (setting === AUTO_BASEMAP) {
    return darkMode
      ? BY_ID.get("dark")!
      : BY_ID.get("voyager")!;
  }
  return BY_ID.get(setting) ?? BASEMAPS[0];
}
