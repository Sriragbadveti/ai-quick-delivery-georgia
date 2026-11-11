/**
 * Delivery promise engine.
 * Total delivery time T = t_pick + t_wait + t_travel + t_handover, each a random variable.
 * The engine samples T and offers the 10-minute promise only if the 90th percentile P90(T) <= 10 min;
 * otherwise it promises the next 5-minute step above P90 (15, 20, ...).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED } from "../../geo/src/config.ts";

export interface PromiseRequest { store: string; cell: string; band: string; expectedWaitMin: number; samples?: number }
export interface PromiseResponse { promisedMinutes: number; tenMinute: boolean; p50: number; p90: number; travelMin: number; inZone: boolean }

const tt = JSON.parse(readFileSync(resolve(GENERATED, "travel_times.json"), "utf8")) as { travel: Record<string, Record<string, Record<string, number>>> };
const zones = JSON.parse(readFileSync(resolve(GENERATED, "cells.json"), "utf8")) as { zoneCells: Record<string, Record<string, string[]>> };
const zoneSets: Record<string, Record<string, Set<string>>> = {};
for (const [band, byStore] of Object.entries(zones.zoneCells)) { zoneSets[band] = {}; for (const [s, cs] of Object.entries(byStore)) zoneSets[band][s] = new Set(cs); }

export const MODEL = { pickMedian: 1.4, pickSigma: 0.3, travelSigma: 0.18, waitSigma: 0.4, handoverMean: 0.8, handoverSd: 0.2, target: 10, quantile: 0.9 };

function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry(seed: number) { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function normal(r: () => number) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function quantile(xs: number[], q: number) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

export function travelMinutes(band: string, store: string, cell: string): number {
  const t = tt.travel[band]?.[store]?.[cell];
  if (t === undefined) throw new Error(`no travel time for ${band}/${store}/${cell}`);
  return t;
}

export function computePromise(req: PromiseRequest): PromiseResponse {
  const travel = travelMinutes(req.band, req.store, req.cell);
  const inZone = zoneSets[req.band]?.[req.store]?.has(req.cell) ?? false;
  const r = mulberry(hashSeed(`${req.store}|${req.cell}|${req.band}|${req.expectedWaitMin.toFixed(2)}`));
  const n = req.samples ?? 400, T: number[] = [];
  for (let i = 0; i < n; i++) {
    const pick = MODEL.pickMedian * Math.exp(MODEL.pickSigma * normal(r));
    const wait = req.expectedWaitMin > 0 ? req.expectedWaitMin * Math.exp(MODEL.waitSigma * normal(r)) : 0;
    const ride = travel * Math.exp(MODEL.travelSigma * normal(r));
    const hand = Math.max(0.2, MODEL.handoverMean + MODEL.handoverSd * normal(r));
    T.push(pick + wait + ride + hand);
  }
  const p50 = quantile(T, 0.5), p90 = quantile(T, MODEL.quantile);
  const tenMinute = inZone && p90 <= MODEL.target;
  const promisedMinutes = tenMinute ? MODEL.target : Math.max(15, Math.ceil(p90 / 5) * 5);
  return { promisedMinutes, tenMinute, p50: +p50.toFixed(2), p90: +p90.toFixed(2), travelMin: travel, inZone };
}
