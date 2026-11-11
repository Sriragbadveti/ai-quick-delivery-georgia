/**
 * Road-network travel times for two-wheel couriers on the OpenStreetMap network of Tbilisi.
 * Input: data/raw/tbilisi_roads.csv.gz, extracted from the Geofabrik Georgia extract with scripts/extract_tbilisi.py.
 * Edge time = length / class speed (free flow), respecting one-way streets; band speeds scale free-flow times.
 * Shortest paths: Dijkstra with a binary heap from each origin over the largest strongly connected part.
 */
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { ROOT, city, haversineKm, type LatLng } from "./config.ts";
import type { TravelTimeProvider } from "./travel.ts";

export const ROADS_FILE = resolve(ROOT, "data/raw/tbilisi_roads.csv.gz");
// Free-flow riding speeds (km/h) for a moped/e-scooter courier by OSM road class
export const CLASS_SPEED: Record<string, number> = {
  motorway: 45, motorway_link: 35, trunk: 40, trunk_link: 30, primary: 34, primary_link: 26, secondary: 30, secondary_link: 24,
  tertiary: 27, tertiary_link: 22, unclassified: 22, residential: 20, road: 20, living_street: 10, service: 14,
};

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) { const k = this.k, v = this.v; k.push(key); v.push(val); let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; } }
  pop(): [number, number] { const k = this.k, v = this.v; const top: [number, number] = [k[0], v[0]]; const lk = k.pop()!, lv = v.pop()!;
    if (k.length) { k[0] = lk; v[0] = lv; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break;
      [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; } } return top; }
}

export class RoadGraph {
  lat: number[] = []; lng: number[] = [];
  adj: { to: number; min: number }[][] = [];
  radj: { to: number; min: number }[][] = [];
  edges = 0; lengthKm = 0;
  private grid = new Map<string, number[]>();

  static load(file = ROADS_FILE): RoadGraph {
    const g = new RoadGraph();
    const idOf = new Map<string, number>();
    const node = (ref: string, la: number, lo: number) => {
      let i = idOf.get(ref);
      if (i === undefined) { i = g.lat.length; idOf.set(ref, i); g.lat.push(la); g.lng.push(lo); g.adj.push([]); g.radj.push([]); }
      return i;
    };
    const text = gunzipSync(readFileSync(file)).toString("utf8");
    for (const line of text.split("\n").slice(1)) {
      if (!line) continue;
      const [, hw, oneway, , nodes] = line.split(",");
      const speed = CLASS_SPEED[hw] ?? 15;
      const pts = nodes.split(";").map((p) => { const [r, la, lo] = p.split(":"); return node(r, +la, +lo); });
      const fwd = oneway !== "-1", bwd = !(oneway === "yes" || oneway === "1" || oneway === "true");
      for (let j = 1; j < pts.length; j++) {
        let a = pts[j - 1], b = pts[j];
        const km = haversineKm({ lat: g.lat[a], lng: g.lng[a] }, { lat: g.lat[b], lng: g.lng[b] });
        const min = (km / speed) * 60;
        g.lengthKm += km;
        if (oneway === "-1") [a, b] = [b, a];
        if (fwd || oneway === "-1") { g.adj[a].push({ to: b, min }); g.radj[b].push({ to: a, min }); g.edges++; }
        if (bwd && oneway !== "-1") { g.adj[b].push({ to: a, min }); g.radj[a].push({ to: b, min }); g.edges++; }
      }
    }
    g.keepLargestComponent();
    return g;
  }

  /** Keep nodes reachable both from and to a central node (largest strongly connected part, approximately). */
  private keepLargestComponent() {
    const centre = this.nearestRaw({ lat: 41.7151, lng: 44.8027 });
    const reach = (adj: { to: number }[][]) => { const seen = new Uint8Array(this.lat.length); const st = [centre]; seen[centre] = 1;
      while (st.length) { const u = st.pop()!; for (const e of adj[u]) if (!seen[e.to]) { seen[e.to] = 1; st.push(e.to); } } return seen; };
    const f = reach(this.adj), b = reach(this.radj);
    for (let i = 0; i < this.lat.length; i++) if (f[i] && b[i]) {
      const key = `${Math.floor(this.lat[i] * 200)}|${Math.floor(this.lng[i] * 200)}`;
      (this.grid.get(key) ?? this.grid.set(key, []).get(key)!).push(i);
    }
  }
  private nearestRaw(p: LatLng) { let best = 0, bd = Infinity; for (let i = 0; i < this.lat.length; i++) { const d = (this.lat[i] - p.lat) ** 2 + (this.lng[i] - p.lng) ** 2; if (d < bd) { bd = d; best = i; } } return best; }

  /** Nearest well-connected node and the straight-line distance to it (km). */
  nearest(p: LatLng): { node: number; km: number } {
    const ky = Math.floor(p.lat * 200), kx = Math.floor(p.lng * 200);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 6 && best < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      for (const i of this.grid.get(`${ky + dy}|${kx + dx}`) ?? []) { const d = haversineKm(p, { lat: this.lat[i], lng: this.lng[i] }); if (d < bd) { bd = d; best = i; } }
    }
    return { node: best, km: bd };
  }

  /** Free-flow minutes from a source node to every node (reverse=true: from every node to the source). */
  dijkstra(src: number, reverse = false): Float64Array {
    const adj = reverse ? this.radj : this.adj;
    const dist = new Float64Array(this.lat.length).fill(Infinity); dist[src] = 0;
    const h = new Heap(); h.push(0, src);
    while (h.size) { const [d, u] = h.pop(); if (d > dist[u]) continue;
      for (const e of adj[u]) { const nd = d + e.min; if (nd < dist[e.to]) { dist[e.to] = nd; h.push(nd, e.to); } } }
    return dist;
  }
}

/** Travel-time provider on the OSM road network. Walking the last metres from the road to the cell centre is added at 5 km/h. */
export class OsmGraphProvider implements TravelTimeProvider {
  readonly name = "osm-road-network";
  private g: RoadGraph;
  private cache = new Map<string, Float64Array>();
  constructor(g?: RoadGraph) { this.g = g ?? RoadGraph.load(); }
  get graph() { return this.g; }
  async matrix(origins: LatLng[], destinations: LatLng[], band: string): Promise<number[][]> {
    const scale = city.congestion[band] ?? 1;
    const dn = destinations.map((d) => this.g.nearest(d));
    return origins.map((o) => {
      const on = this.g.nearest(o);
      const key = `${on.node}`;
      let dist = this.cache.get(key);
      if (!dist) { dist = this.g.dijkstra(on.node); this.cache.set(key, dist); }
      return dn.map((d) => (dist![d.node] * scale) + ((on.km + d.km) / 5) * 60 * 0.5);
    });
  }
}

export function osmAvailable() { return existsSync(ROADS_FILE); }
