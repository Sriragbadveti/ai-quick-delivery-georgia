/**
 * Demand forecasting per H3 cell and 15-minute slot with a feed-forward neural network (TensorFlow.js).
 * Train: 18 Aug - 5 Oct 2025 (first two weeks only provide lag features). Test: 6 - 26 Oct 2025.
 * Baseline: seasonal naive (same cell, same slot, one week earlier).
 * Metric: WAPE = sum|error| / sum(actual), at cell-slot level and at store-hour level.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import * as tf from "@tensorflow/tfjs";
import { gridDisk } from "h3-js";
import { GENERATED, ROOT, city } from "../../geo/src/config.ts";
import { SLOTS, OPEN_H, SLOT_MIN, isWeekend, type DayInfo, type CellRow } from "./model.ts";

const hist = JSON.parse(readFileSync(resolve(GENERATED, "demand_history.json"), "utf8")) as { cells: CellRow[]; days: DayInfo[]; counts: number[][][]; weatherSource: string };
const { cells, days, counts } = hist;
const TEST_START = days.findIndex((d) => d.date === "2025-10-06");
const FIRST = 7;
const stores = [...new Set(cells.map((c) => c.store))];
const cellIdx = new Map(cells.map((c, i) => [c.cell, i]));
const neighbours = cells.map((c) => gridDisk(c.cell, 1).map((n) => cellIdx.get(n)).filter((i): i is number => i !== undefined));
const maxPop = Math.max(...cells.map((c) => c.population));

/** Seasonal level: mean of the same cell, slot +-1, over up to four previous same weekdays without matches or holidays. */
function level(d: number, i: number, k: number): number {
  let sm = 0, n = 0;
  for (const w of [7, 14, 21, 28]) {
    const dd = d - w;
    if (dd < 0 || days[dd].match || days[dd].holiday) continue;
    for (const kk of [k - 1, k, k + 1]) if (kk >= 0 && kk < SLOTS) { sm += counts[dd][i][kk]; n++; }
  }
  if (n === 0) for (const kk of [k - 1, k, k + 1]) if (kk >= 0 && kk < SLOTS) { sm += counts[d - 7][i][kk]; n++; }
  return sm / n;
}
/** Store-level seasonal level shared by all cells of the store (less noisy than one cell). */
const storeCells = new Map(stores.map((s) => [s, cells.map((c, i) => (c.store === s ? i : -1)).filter((i) => i >= 0)]));
const storeShare = cells.map((c, i) => { const ids = storeCells.get(c.store)!; const tot = ids.reduce((a, j) => a + cells[j].population, 0); return c.population / tot; });
function levelOf(d: number, i: number, k: number): number {
  const ids = storeCells.get(cells[i].store)!;
  const storeLevel = ids.reduce((a, j) => a + level(d, j, k), 0);
  return 0.5 * level(d, i, k) + 0.5 * storeLevel * storeShare[i] + 0.02;
}

function features(d: number, i: number, k: number): number[] {
  const day = days[d], c = cells[i];
  const hour = OPEN_H + Math.floor(k / 4), minute = OPEN_H * 60 + k * SLOT_MIN;
  const ang = (2 * Math.PI * minute) / 1440;
  const lag7 = counts[d - 7][i][k], lag14 = d >= 14 ? counts[d - 14][i][k] : lag7;
  const nb7 = neighbours[i].reduce((s, j) => s + counts[d - 7][j][k], 0) / neighbours[i].length;
  // smoothed seasonal level: same cell, +-1 slot, last two weeks
  const lv = levelOf(d, i, k);
  const dow = Array.from({ length: 7 }, (_, j) => (day.dow === j ? 1 : 0));
  const m = day.match;
  const t = m ? minute - m.kickoffHour * 60 : 9999;
  const bump = (mu: number, sd: number) => (m ? Math.exp(-0.5 * ((t - mu) / sd) ** 2) : 0);
  const att = m ? m.attendance / city.stadium.capacity : 0;
  return [
    Math.sin(ang), Math.cos(ang), ...dow, day.holiday ? 1 : 0, isWeekend(day) ? 1 : 0,
    (day.tempC[hour] - 20) / 10, Math.min(day.precipMm[hour], 8) / 8, day.precipMm[hour] > 0.2 ? 1 : 0,
    Math.log(lv), (lag7 - lv) / (lv + 0.5), (lag14 - lv) / (lv + 0.5), (nb7 - lv) / (lv + 0.5), c.population / maxPop,
    m ? 1 : 0, att * bump(-55, 30), att * bump(52, 10), att * bump(110, 20), m?.national ? att : 0,
    Math.exp(-c.stadiumKm / 2.5),
    // distance-weighted event intensity (closer to the stadium and closer to kick-off = stronger)
    att * bump(-55, 30) * Math.exp(-c.stadiumKm / 2.5), att * bump(52, 10) * Math.exp(-c.stadiumKm / 2.5), att * bump(110, 20) * Math.exp(-c.stadiumKm / 2.5),
    ...stores.map((s) => (c.store === s ? 1 : 0)),
  ];
}

function dataset(d0: number, d1: number) {
  const X: number[][] = [], y: number[] = [], lv: number[] = [], key: [number, number, number][] = [];
  for (let d = d0; d < d1; d++) for (let i = 0; i < cells.length; i++) for (let k = 0; k < SLOTS; k++) {
    X.push(features(d, i, k)); y.push(counts[d][i][k]); lv.push(levelOf(d, i, k)); key.push([d, i, k]);
  }
  return { X, y, lv, key };
}

const wape = (a: number[], p: number[]) => a.reduce((s, v, j) => s + Math.abs(v - p[j]), 0) / a.reduce((s, v) => s + v, 0);

async function main() {
  await tf.setBackend("cpu");
  const train = dataset(FIRST, TEST_START), test = dataset(TEST_START, days.length);
  const nf = train.X[0].length;
  // standardise features with training statistics
  const mean = Array(nf).fill(0), sd = Array(nf).fill(0);
  for (const r of train.X) r.forEach((v, j) => (mean[j] += v / train.X.length));
  for (const r of train.X) r.forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / train.X.length));
  const norm = (X: number[][]) => X.map((r) => r.map((v, j) => (sd[j] > 1e-9 ? (v - mean[j]) / Math.sqrt(sd[j]) : 0)));

  // The network predicts a log-multiplier m on the seasonal level: yhat = level * exp(m).
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [nf], units: 32, activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: 1 }) }));
  model.add(tf.layers.dense({ units: 16, activation: "relu", kernelInitializer: tf.initializers.glorotUniform({ seed: 2 }) }));
  model.add(tf.layers.dense({ units: 1, kernelInitializer: tf.initializers.zeros() }));
  const opt = tf.train.adam(0.003);
  const EPOCHS = 10, BATCH = 2048;
  const Xn = norm(train.X);
  const order = Array.from({ length: Xn.length }, (_, j) => j);
  let r = 7; const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const t0 = Date.now();
  const losses: number[] = [];
  for (let e = 0; e < EPOCHS; e++) {
    for (let j = order.length - 1; j > 0; j--) { const q = Math.floor(rand() * (j + 1)); [order[j], order[q]] = [order[q], order[j]]; }
    let sum = 0, nb = 0;
    for (let b = 0; b < order.length; b += BATCH) {
      const ids = order.slice(b, b + BATCH);
      const loss = tf.tidy(() => {
        const xb = tf.tensor2d(ids.map((j) => Xn[j])), yb = tf.tensor1d(ids.map((j) => train.y[j])), lb = tf.tensor1d(ids.map((j) => train.lv[j]));
        return opt.minimize(() => {
          const m = (model.apply(xb) as tf.Tensor).reshape([-1]);
          const yhat = tf.mul(lb, tf.exp(m));
          return tf.mean(tf.sub(yhat, tf.mul(yb, tf.log(tf.add(yhat, 1e-6))))) as tf.Scalar;
        }, true)!;
      });
      sum += loss.dataSync()[0]; nb++; loss.dispose();
    }
    losses.push(sum / nb);
  }
  const trainSec = Math.round((Date.now() - t0) / 1000);
  const h = { history: { loss: losses, val_loss: undefined as number[] | undefined } };
  const xt = tf.tensor2d(norm(test.X));
  const mOut = Array.from((model.predict(xt) as tf.Tensor).dataSync());
  const pred = mOut.map((m, j) => test.lv[j] * Math.exp(m));
  const naive = test.key.map(([d, i, k]) => counts[d - 7][i][k]);

  // aggregate to store-hour
  const agg = (vals: number[], filter: (d: number) => boolean = () => true) => {
    const m = new Map<string, number>();
    test.key.forEach(([d, i, k], j) => { if (!filter(d)) return; const key = `${d}|${cells[i].store}|${Math.floor(k / 4)}`; m.set(key, (m.get(key) ?? 0) + vals[j]); });
    return m;
  };
  const storeHour = (filter?: (d: number) => boolean) => {
    const A = agg(test.y, filter), P = agg(pred, filter), N = agg(naive, filter);
    const keys = [...A.keys()];
    return { model: wape(keys.map((k) => A.get(k)!), keys.map((k) => P.get(k)!)), naive: wape(keys.map((k) => A.get(k)!), keys.map((k) => N.get(k)!)) };
  };
  const isMatch = (d: number) => days[d].match != null;
  const isHoliday = (d: number) => days[d].holiday != null;
  const sel = (f: (d: number) => boolean) => { const idx = test.key.map(([d], j) => (f(d) ? j : -1)).filter((j) => j >= 0); return { model: wape(idx.map((j) => test.y[j]), idx.map((j) => pred[j])), naive: wape(idx.map((j) => test.y[j]), idx.map((j) => naive[j])) }; };

  const results = {
    weatherSource: hist.weatherSource, trainRows: train.y.length, testRows: test.y.length, features: nf, epochs: EPOCHS, trainSeconds: trainSec,
    finalLoss: h.history.loss.at(-1), finalValLoss: h.history.val_loss?.at(-1),
    cellSlot: { all: sel(() => true), matchDays: sel(isMatch), holidays: sel(isHoliday) },
    storeHour: { all: storeHour(), matchDays: storeHour(isMatch), normalDays: storeHour((d) => !isMatch(d) && !isHoliday(d)) },
  };
  mkdirSync(resolve(ROOT, "results"), { recursive: true });
  writeFileSync(resolve(ROOT, "results/forecast_metrics.json"), JSON.stringify(results, null, 2));

  // store-hour series for every test day (actual / model / naive) for figures and staffing
  const A = agg(test.y), P = agg(pred), N = agg(naive);
  const series: Record<string, Record<string, { actual: number[]; model: number[]; naive: number[] }>> = {};
  for (let d = TEST_START; d < days.length; d++) {
    series[days[d].date] = {};
    for (const s of stores) {
      const g = (m: Map<string, number>) => Array.from({ length: SLOTS / 4 }, (_, hh) => Math.round((m.get(`${d}|${s}|${hh}`) ?? 0) * 100) / 100);
      series[days[d].date][s] = { actual: g(A), model: g(P), naive: g(N) };
    }
  }
  writeFileSync(resolve(GENERATED, "forecast_store_hour.json"), JSON.stringify({ openHour: OPEN_H, series }));
  await model.save(`file://${resolve(ROOT, "results/forecast_model")}`).catch(() => undefined);
  console.log(JSON.stringify(results, null, 2));
}

main();
