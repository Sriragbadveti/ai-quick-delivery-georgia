/**
 * Dark-store siting by greedy maximum coverage. Candidates for a store are the populated H3 cells of its
 * district (cells assigned to the nearest district centre). Stores are placed one at a time; each picks the
 * candidate whose 7-minute riding zone (midday band, OSM road network) adds the most residents not already
 * covered by previously placed stores. Writes config/stores.sited.json.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cellToLatLng } from "h3-js";
import { city, ROOT, haversineKm } from "./config.ts";
import { populationByCell } from "./population.ts";
import { OsmGraphProvider } from "./roadGraph.ts";

const TARGETS = ["Isani", "Saburtalo", "Vake"]; // placement order (largest initial coverage first)
async function main() {
  const provider = new OsmGraphProvider();
  const g = provider.graph;
  const pop = populationByCell();
  const popCells = [...pop.entries()].map(([c, p]) => { const [lat, lng] = cellToLatLng(c); return { c, p, lat, lng, node: g.nearest({ lat, lng }) }; });
  const band = "midday", scale = city.congestion[band];
  const covered = new Set<string>();
  const coverage = (lat: number, lng: number, marginal = false) => {
    const o = g.nearest({ lat, lng }); const d = g.dijkstra(o.node);
    let res = 0, cells = 0; const set: string[] = [];
    for (const pc of popCells) { const t = d[pc.node.node] * scale + ((o.km + pc.node.km) / 5) * 60 * 0.5;
      if (t <= city.zoneRidingMinutes) { set.push(pc.c); if (!marginal || !covered.has(pc.c)) { res += pc.p; cells++; } } }
    return { res: Math.round(res), cells, set };
  };
  const districtOf = (lat: number, lng: number) => { let b = "", bd = Infinity; for (const d of city.districts) { const x = haversineKm({ lat, lng }, d); if (x < bd) { bd = x; b = d.name; } } return b; };
  const initial = Object.fromEntries(city.stores.map((s) => [s.id, coverage(s.lat, s.lng)]));
  const stores = [], report = [];
  for (const name of TARGETS) {
    const dc = city.districts.find((d) => d.name === name)!;
    const cands = popCells.filter((pc) => districtOf(pc.lat, pc.lng) === name && haversineKm(pc, dc) <= 2.5);
    let best = { lat: dc.lat, lng: dc.lng, res: -1, cells: 0, set: [] as string[] };
    for (const pc of cands) { const cv = coverage(pc.lat, pc.lng, true); if (cv.res > best.res) best = { lat: pc.lat, lng: pc.lng, ...cv }; }
    best.set.forEach((c) => covered.add(c));
    const id = name.toLowerCase();
    stores.push({ id, name, lat: +best.lat.toFixed(5), lng: +best.lng.toFixed(5) });
    report.push({ store: id, candidates: cands.length, initialResidents: initial[id]?.res, sitedNewResidents: best.res, sitedCells: best.set.length });
  }
  const totalInitial = Object.values(initial).reduce((a, b) => a + b.res, 0);
  writeFileSync(resolve(ROOT, "config/stores.sited.json"), JSON.stringify({ method: "greedy maximum coverage, midday 7-min riding zone, OSM road network", stores, report, coveredResidents: Math.round([...covered].reduce((a, c) => a + (pop.get(c) ?? 0), 0)), initialGuessResidentsSum: totalInitial }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main();
