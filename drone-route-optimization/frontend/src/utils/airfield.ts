/**
 * Whether a zone name indicates an airfield (airstrip / airport / runway /
 * helipad).  Used by the map layers to label the DGCA zones precisely: red
 * airfield footprints are the actual runways (prohibited), while the amber
 * polygons around them are the approach funnels and controlled-airspace
 * circles (passable with prior permission).
 */
export function isAirfieldName(name: string): boolean {
  return /airstrip|airfield|airport|runway|helipad/i.test(name);
}
