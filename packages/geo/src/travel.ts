import { city, haversineKm, type LatLng } from "./config.ts";

/**
 * A travel-time provider returns riding times in minutes from each origin to each destination
 * for a given time band. Implementations:
 *  - ApproxProvider: haversine distance x circuity factor at a band-specific riding speed.
 *    Used until the road network is available; it has no hills or real streets.
 *  - OsrmProvider: OSRM /table on the OpenStreetMap road network (self-hosted or public).
 *  - GoogleRoutesProvider (planned): Google Routes API computeRouteMatrix, traffic-aware.
 */
export interface TravelTimeProvider {
  readonly name: string;
  matrix(origins: LatLng[], destinations: LatLng[], band: string): Promise<number[][]>;
}

export function bandSpeedKmh(band: string): number {
  if (band === "weekend") return city.weekendSpeedKmh;
  const b = city.timeBands[band];
  if (!b) throw new Error(`unknown time band ${band}`);
  return b.speedKmh;
}

export class ApproxProvider implements TravelTimeProvider {
  readonly name = "approx-haversine";
  async matrix(origins: LatLng[], destinations: LatLng[], band: string): Promise<number[][]> {
    const v = bandSpeedKmh(band), { circuityFactor, fixedMinutes } = city.approxTravel;
    return origins.map((o) => destinations.map((d) => fixedMinutes + (haversineKm(o, d) * circuityFactor / v) * 60));
  }
}

/** OSRM table service. Durations come from the routing profile; band speeds scale them relative to free flow. */
export class OsrmProvider implements TravelTimeProvider {
  readonly name = "osrm";
  constructor(private baseUrl = process.env.OSRM_URL ?? "http://localhost:5000", private profile = "driving", private freeFlowKmh = 18) {}
  async matrix(origins: LatLng[], destinations: LatLng[], band: string): Promise<number[][]> {
    const out: number[][] = [];
    const scale = this.freeFlowKmh / bandSpeedKmh(band);
    const chunk = 80; // keep URLs short
    for (let i = 0; i < origins.length; i += chunk) {
      const os = origins.slice(i, i + chunk);
      const coords = [...os, ...destinations].map((p) => `${p.lng},${p.lat}`).join(";");
      const src = os.map((_, k) => k).join(";");
      const dst = destinations.map((_, k) => k + os.length).join(";");
      const url = `${this.baseUrl}/table/v1/${this.profile}/${coords}?sources=${src}&destinations=${dst}&annotations=duration`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const body = (await res.json()) as { durations: (number | null)[][] };
      for (const row of body.durations) out.push(row.map((s) => (s == null ? Infinity : (s / 60) * scale)));
    }
    return out;
  }
}

/** Provider choice: TRAVEL_PROVIDER=approx|osrm|osm; default is the OSM road network when the extract exists. */
export async function providerFromEnv(): Promise<TravelTimeProvider> {
  const want = process.env.TRAVEL_PROVIDER;
  if (want === "osrm") return new OsrmProvider();
  if (want === "approx") return new ApproxProvider();
  const { OsmGraphProvider, osmAvailable } = await import("./roadGraph.ts");
  if (want === "osm" || osmAvailable()) return new OsmGraphProvider();
  return new ApproxProvider();
}
