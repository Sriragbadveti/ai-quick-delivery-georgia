/**
 * Service-zone builder.
 *  1. Cover the area around each dark store with H3 cells (resolution 9).
 *  2. Get riding times from the store to every cell centre for each time band.
 *  3. Keep cells reachable within the riding budget (7 minutes) and merge them into a polygon.
 *  4. Write zones (GeoJSON), the store-to-cell travel table and per-cell attributes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gridDisk, latLngToCell, cellToLatLng, cellsToMultiPolygon } from "h3-js";
import * as turf from "@turf/turf";
import { city, GENERATED, BANDS, haversineKm } from "./config.ts";
import { providerFromEnv } from "./travel.ts";
import { populationByCell } from "./population.ts";

async function main() {
  const provider = await providerFromEnv();
  const res = city.h3Resolution;
  const pop = populationByCell(res);

  // candidate cells: union of rings around every store
  const candidate = new Set<string>();
  for (const s of city.stores) for (const c of gridDisk(latLngToCell(s.lat, s.lng, res), city.searchRings)) candidate.add(c);
  const cells = [...candidate];
  const centres = cells.map((c) => { const [lat, lng] = cellToLatLng(c); return { lat, lng }; });

  // travel[band][storeId][cell] = minutes
  const travel: Record<string, Record<string, Record<string, number>>> = {};
  const storeToStore: Record<string, Record<string, Record<string, number>>> = {};
  for (const band of BANDS) {
    const m = await provider.matrix(city.stores, centres, band);
    travel[band] = {};
    city.stores.forEach((s, i) => {
      travel[band][s.id] = {};
      cells.forEach((c, j) => { travel[band][s.id][c] = Math.round(m[i][j] * 100) / 100; });
    });
    const ss = await provider.matrix(city.stores, city.stores, band);
    storeToStore[band] = {};
    city.stores.forEach((a, i) => { storeToStore[band][a.id] = {}; city.stores.forEach((b, j) => { storeToStore[band][a.id][b.id] = Math.round(ss[i][j] * 100) / 100; }); });
  }

  // zones per store and band
  const features: GeoJSON.Feature[] = [];
  const zoneCells: Record<string, Record<string, string[]>> = {};
  for (const band of BANDS) {
    zoneCells[band] = {};
    for (const s of city.stores) {
      const inZone = cells.filter((c) => travel[band][s.id][c] <= city.zoneRidingMinutes);
      zoneCells[band][s.id] = inZone;
      const mp = cellsToMultiPolygon(inZone, true); // GeoJSON order [lng, lat]
      let shape: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> = turf.multiPolygon(mp);
      // smooth the jagged hexagon outline slightly (+40 m, -40 m)
      shape = turf.buffer(turf.buffer(shape, 0.04, { units: "kilometers" })!, -0.04, { units: "kilometers" })! as typeof shape;
      const residents = inZone.reduce((acc, c) => acc + (pop.get(c) ?? 0), 0);
      shape.properties = { store: s.id, band, cells: inZone.length, residents: Math.round(residents), areaKm2: Math.round(turf.area(shape) / 1e4) / 100 };
      features.push(shape);
    }
  }

  // per-cell attributes; each cell is served by the store with the shortest off-peak riding time
  const cellInfo = cells.map((c, j) => {
    let best = city.stores[0].id, bestT = Infinity;
    for (const s of city.stores) { const t = travel.midday[s.id][c]; if (t < bestT) { bestT = t; best = s.id; } }
    return { cell: c, lat: centres[j].lat, lng: centres[j].lng, population: Math.round(pop.get(c) ?? 0), store: best,
      stadiumKm: Math.round(haversineKm(centres[j], city.stadium) * 100) / 100 };
  });

  mkdirSync(GENERATED, { recursive: true });
  writeFileSync(resolve(GENERATED, "zones.geojson"), JSON.stringify(turf.featureCollection(features)));
  writeFileSync(resolve(GENERATED, "travel_times.json"), JSON.stringify({ provider: provider.name, resolution: res, travel, storeToStore }));
  writeFileSync(resolve(GENERATED, "cells.json"), JSON.stringify({ provider: provider.name, zoneCells, cells: cellInfo }));

  const summary = features.map((f) => f.properties);
  writeFileSync(resolve(GENERATED, "zones_summary.json"), JSON.stringify({ provider: provider.name, summary }, null, 2));
  console.log(`provider=${provider.name} candidate cells=${cells.length}`);
  for (const p of summary.filter((p) => p!.band === "midday" || p!.band === "evening_peak")) console.log(p);
}

main().catch((e) => { console.error(e); process.exit(1); });
