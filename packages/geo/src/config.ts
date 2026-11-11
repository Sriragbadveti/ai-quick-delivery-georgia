import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const GENERATED = resolve(ROOT, "data/generated");

export interface LatLng { lat: number; lng: number }
export interface Store extends LatLng { id: string; name: string }
export interface District extends LatLng { name: string; population2014: number }
export interface CityConfig {
  city: string;
  h3Resolution: number;
  zoneRidingMinutes: number;
  searchRings: number;
  bbox: { south: number; west: number; north: number; east: number };
  populationTotal2026: number;
  stores: Store[];
  districts: District[];
  stadium: LatLng & { name: string; capacity: number };
  timeBands: Record<string, { hours: [number, number]; speedKmh: number }>;
  weekendSpeedKmh: number;
  operatingHours: [number, number];
  approxTravel: { circuityFactor: number; fixedMinutes: number };
  congestion: Record<string, number>;
}

export const city: CityConfig = JSON.parse(readFileSync(resolve(ROOT, "config/city.json"), "utf8"));
// Store locations chosen by the siting step (maximum coverage) replace the initial guesses when available.
const sited = resolve(ROOT, "config/stores.sited.json");
if (existsSync(sited) && process.env.USE_INITIAL_STORES !== "1") city.stores = JSON.parse(readFileSync(sited, "utf8")).stores;

/** Time band for a given hour of day; weekends use a single band. */
export function timeBandFor(hour: number, weekend = false): string {
  if (weekend) return "weekend";
  for (const [id, b] of Object.entries(city.timeBands)) if (hour >= b.hours[0] && hour < b.hours[1]) return id;
  return "night";
}
export const BANDS = [...Object.keys(city.timeBands), "weekend"];

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
