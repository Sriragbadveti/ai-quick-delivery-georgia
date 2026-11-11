import { latLngToCell, cellToLatLng, polygonToCells } from "h3-js";
import { city, haversineKm } from "./config.ts";

/**
 * Approximate residents per H3 cell: every cell in the city bounding box is assigned to the
 * nearest district centre (a Voronoi approximation of district borders), and each district's
 * population, scaled to the 2026 city total, is spread evenly over its cells.
 * This is a documented simplification until real district polygons are added.
 */
export function populationByCell(res = city.h3Resolution): Map<string, number> {
  const { south, west, north, east } = city.bbox;
  const poly = [[south, west], [south, east], [north, east], [north, west], [south, west]];
  const cells = polygonToCells(poly, res);
  const total2014 = city.districts.reduce((s, d) => s + d.population2014, 0);
  const scale = city.populationTotal2026 / total2014;
  const owner = new Map<string, number>();
  const counts = new Array(city.districts.length).fill(0);
  for (const c of cells) {
    const [lat, lng] = cellToLatLng(c);
    let best = 0, bestD = Infinity;
    city.districts.forEach((d, i) => { const dd = haversineKm({ lat, lng }, d); if (dd < bestD) { bestD = dd; best = i; } });
    // cells far from every district centre (mountains, outskirts) get no residents
    if (bestD > 3.2) continue;
    owner.set(c, best); counts[best]++;
  }
  const pop = new Map<string, number>();
  for (const [c, i] of owner) pop.set(c, (city.districts[i].population2014 * scale) / counts[i]);
  return pop;
}

export { latLngToCell };
