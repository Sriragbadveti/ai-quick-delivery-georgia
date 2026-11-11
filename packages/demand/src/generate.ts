/**
 * Generates 12 weeks of order history (4 Aug - 26 Oct 2025) per H3 cell and 15-minute slot,
 * plus the expected demand for four simulation scenario days.
 * Weather is synthetic unless data/raw/weather_tbilisi.csv (Open-Meteo hourly export) exists.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED, ROOT } from "../../geo/src/config.ts";
import { rng, poisson, lambda, servedCells, SLOTS, PARAMS, type DayInfo, type Match } from "./model.ts";

const START = new Date(Date.UTC(2025, 7, 4)); // Monday 4 Aug 2025
const DAYS = 84;
const HOLIDAYS: Record<string, string> = { "2025-08-28": "Mariamoba", "2025-10-14": "Svetitskhovloba" };
// Synthetic home-match calendar at Dinamo Arena (kick-off hour, attendance, national team?)
const MATCHES: Record<string, Match> = {
  "2025-08-09": { kickoffHour: 20, attendance: 28000, national: false },
  "2025-08-23": { kickoffHour: 19, attendance: 24000, national: false },
  "2025-09-05": { kickoffHour: 21, attendance: 52000, national: true },
  "2025-09-13": { kickoffHour: 20, attendance: 30000, national: false },
  "2025-09-27": { kickoffHour: 19, attendance: 26000, national: false },
  "2025-10-08": { kickoffHour: 20, attendance: 50000, national: true },
  "2025-10-15": { kickoffHour: 20, attendance: 54000, national: true }, // match scenario day
};
export const SCENARIOS: Record<string, string> = { weekday: "2025-10-21", rain: "2025-10-23", weekend: "2025-10-25", match: "2025-10-15" };

function loadWeatherCsv(): Map<string, { t: number; p: number }> | null {
  const f = resolve(ROOT, "data/raw/weather_tbilisi.csv");
  if (!existsSync(f)) return null;
  const m = new Map<string, { t: number; p: number }>();
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const [time, t, p] = line.split(",");
    if (!/^\d{4}-\d\d-\d\dT\d\d/.test(time ?? "")) continue;
    m.set(time.slice(0, 13), { t: Number(t), p: Number(p) });
  }
  return m;
}

function buildDays(): { days: DayInfo[]; weatherSource: string } {
  const r = rng(2025);
  const csv = loadWeatherCsv();
  const days: DayInfo[] = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(START.getTime() + i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const tempC: number[] = [], precipMm: number[] = [];
    if (csv) {
      for (let h = 0; h < 24; h++) { const w = csv.get(`${date}T${String(h).padStart(2, "0")}`); tempC.push(w?.t ?? 20); precipMm.push(w?.p ?? 0); }
    } else {
      const seasonal = 30 - (i / DAYS) * 13; // ~30°C in early August to ~17°C in late October
      const rainy = r() < 0.18;
      const rs = 8 + Math.floor(r() * 12), rl = 3 + Math.floor(r() * 5), ri = 0.8 + r() * 4;
      for (let h = 0; h < 24; h++) {
        tempC.push(Math.round((seasonal + 5 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + (r() - 0.5) * 2) * 10) / 10);
        precipMm.push(rainy && h >= rs && h < rs + rl ? Math.round(ri * (0.6 + r() * 0.8) * 10) / 10 : 0);
      }
    }
    days.push({ date, dow: d.getUTCDay(), holiday: HOLIDAYS[date] ?? null, match: MATCHES[date] ?? null, tempC, precipMm });
  }
  // scenario constraints: dry weekday, rainy evening, dry Saturday, dry match day
  const set = (date: string, f: (d: DayInfo) => void) => { const d = days.find((x) => x.date === date); if (d) f(d); };
  for (const k of ["weekday", "weekend", "match"]) set(SCENARIOS[k], (d) => { d.precipMm = d.precipMm.map(() => 0); });
  set(SCENARIOS.rain, (d) => { d.precipMm = d.precipMm.map((_, h) => (h >= 16 && h < 23 ? 6 : 0)); });
  return { days, weatherSource: csv ? "open-meteo csv" : "synthetic" };
}

function main() {
  const cells = servedCells();
  const { days, weatherSource } = buildDays();
  const r = rng(42);
  const stores = [...new Set(cells.map((c) => c.store))];
  // counts[day][cell][slot]
  const counts: number[][][] = [];
  const dayEffect: Record<string, number>[] = [];
  for (const day of days) {
    const eff: Record<string, number> = {};
    for (const s of stores) { const u = Math.max(1e-9, r()), v = r(); eff[s] = Math.exp(PARAMS.dayEffectSigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)); }
    dayEffect.push(eff);
    counts.push(cells.map((c) => Array.from({ length: SLOTS }, (_, k) => poisson(lambda(c.population, c.stadiumKm, day, k) * eff[c.store], r))));
  }
  writeFileSync(resolve(GENERATED, "demand_history.json"), JSON.stringify({ weatherSource, start: days[0].date, cells, days, counts }));

  // expected demand (lambda) for scenario days, used by the simulator to sample orders
  const scenarios: Record<string, unknown> = {};
  for (const [name, date] of Object.entries(SCENARIOS)) {
    const day = days.find((d) => d.date === date)!;
    scenarios[name] = { date, day, lambda: cells.map((c) => Array.from({ length: SLOTS }, (_, k) => Math.round(lambda(c.population, c.stadiumKm, day, k) * 1e4) / 1e4)) };
  }
  writeFileSync(resolve(GENERATED, "scenarios.json"), JSON.stringify({ cells: cells.map((c) => ({ cell: c.cell, store: c.store })), scenarios }));

  const perStoreDay = stores.map((s) => {
    const idx = cells.map((c, i) => (c.store === s ? i : -1)).filter((i) => i >= 0);
    const tot = counts.map((d) => idx.reduce((acc, i) => acc + d[i].reduce((a, b) => a + b, 0), 0));
    return { store: s, cells: idx.length, meanOrdersPerDay: Math.round(tot.reduce((a, b) => a + b, 0) / tot.length) };
  });
  console.log({ weatherSource, days: days.length, cells: cells.length, perStoreDay });
}

main();
