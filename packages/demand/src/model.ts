/**
 * Synthetic demand model for Tbilisi dark-store orders.
 * Expected orders per H3 cell and 15-minute slot = residents x per-capita rate x time-of-day profile
 * x day-of-week x weather x holiday x football-match effect x an unobserved day effect.
 * All parameters are explicit so that the simulation's assumptions can be inspected and varied.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, city } from "../../geo/src/config.ts";

export const SLOT_MIN = 15;
export const [OPEN_H, CLOSE_H] = city.operatingHours;
export const SLOTS = ((CLOSE_H - OPEN_H) * 60) / SLOT_MIN; // 64 slots from 08:00 to 24:00

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function poisson(lambda: number, r: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) { // normal approximation for large rates
    const u = Math.max(1e-12, r()), v = r();
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
  }
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

export interface Match { kickoffHour: number; attendance: number; national: boolean }
export interface DayInfo { date: string; dow: number; holiday: string | null; match: Match | null; tempC: number[]; precipMm: number[] }

// Hour-of-day shape (relative), 08:00..23:00
const WEEKDAY_SHAPE = [0.35, 0.45, 0.6, 0.75, 1.05, 1.1, 0.9, 0.8, 0.8, 0.95, 1.25, 1.6, 1.85, 1.7, 1.3, 0.85];
const WEEKEND_SHAPE = [0.25, 0.4, 0.6, 0.85, 1.05, 1.15, 1.15, 1.1, 1.05, 1.1, 1.3, 1.6, 1.8, 1.7, 1.35, 0.95];
const DOW_FACTOR = [1.15, 0.95, 0.95, 1.0, 1.0, 1.1, 1.2]; // Sun..Sat

export const PARAMS = {
  ordersPerResidentPerDay: 0.006, // calibrated so stores see roughly 250-800 orders per day
  rainPerMm: 0.06, rainCapMm: 8,
  holidayFactor: 1.15,
  matchAmplitude: 1.1, matchDistanceKm: 2.5, matchCitywide: 0.35,
  dayEffectSigma: 0.08,
};

export function isWeekend(d: DayInfo) { return d.dow === 0 || d.dow === 6 || d.holiday != null; }

/** Multiplicative match effect for a slot starting at minute-of-day m, for a cell at distance km from the stadium. */
export function matchFactor(match: Match | null, minuteOfDay: number, stadiumKm: number): number {
  if (!match) return 1;
  const t = minuteOfDay - match.kickoffHour * 60; // minutes relative to kick-off
  const bump = (mu: number, sd: number) => Math.exp(-0.5 * ((t - mu) / sd) ** 2);
  const shape = 1.0 * bump(-55, 30) + 0.7 * bump(52, 10) + 0.4 * bump(110, 20); // pre-match, half-time, after
  const weight = Math.exp(-stadiumKm / PARAMS.matchDistanceKm) + (match.national ? PARAMS.matchCitywide : 0.1);
  return 1 + PARAMS.matchAmplitude * (match.attendance / city.stadium.capacity) * shape * weight;
}

/** Expected orders (lambda) for one cell, one slot, one day — without the unobserved day effect. */
export function lambda(cellPop: number, stadiumKm: number, day: DayInfo, slot: number): number {
  const minute = OPEN_H * 60 + slot * SLOT_MIN;
  const hourIdx = Math.floor(slot / 4);
  const shape = (isWeekend(day) ? WEEKEND_SHAPE : WEEKDAY_SHAPE);
  const shapeNorm = shape.reduce((s, x) => s + x, 0) * 4;
  const base = cellPop * PARAMS.ordersPerResidentPerDay * DOW_FACTOR[day.dow] * shape[hourIdx] / shapeNorm;
  const hour = OPEN_H + hourIdx;
  const rain = 1 + PARAMS.rainPerMm * Math.min(day.precipMm[hour] ?? 0, PARAMS.rainCapMm);
  const temp = day.tempC[hour] ?? 20;
  const heat = temp > 32 && hour >= 12 && hour < 18 ? 1.1 : temp < 5 ? 1.1 : 1;
  const hol = day.holiday ? PARAMS.holidayFactor : 1;
  return base * rain * heat * hol * matchFactor(day.match, minute, stadiumKm);
}

export interface CellRow { cell: string; lat: number; lng: number; population: number; store: string; stadiumKm: number }
/** Cells served by some store: inside the midday zone of their nearest store. */
export function servedCells(): CellRow[] {
  const j = JSON.parse(readFileSync(resolve(GENERATED, "cells.json"), "utf8"));
  const inZone = new Set<string>(Object.values(j.zoneCells.midday as Record<string, string[]>).flat());
  return (j.cells as CellRow[]).filter((c) => inZone.has(c.cell) && j.zoneCells.midday[c.store].includes(c.cell));
}
