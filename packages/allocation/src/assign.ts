/**
 * Order allocation. Every 30 s the waiting orders and available couriers form an assignment problem.
 * Rows = orders; columns = couriers plus one "defer to next round" option per order.
 * cost(courier, order) = predicted age of the order at delivery + 4 x minutes late (vs. its promise)
 *                        + 1.5 if the courier must first move to another dark store.
 * cost(defer, order)   = the same quantity if the order waited one more round with its best courier, + 2.
 * Deferring a fresh order costs little, deferring an order near its promise costs a lot, so scarce
 * couriers go to the most urgent orders. The problem is solved exactly with OR-Tools (Hungarian-type).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED } from "../../geo/src/config.ts";

export interface Order { id: string; store: string; cell: string; placedAt: number; readyAt: number; promiseMin: number }
export interface Courier { id: string; store: string; availableAt: number }
export interface AssignRequest { now: number; band: string; orders: Order[]; couriers: Courier[] }
export interface Assignment { orderId: string; courierId: string; startAt: number; predictedDeliveredAt: number }

const tt = JSON.parse(readFileSync(resolve(GENERATED, "travel_times.json"), "utf8")) as {
  travel: Record<string, Record<string, Record<string, number>>>; storeToStore: Record<string, Record<string, Record<string, number>>>;
};
export const PARAMS = { latePenalty: 4, transferPenalty: 1.5, deferPenalty: 2, roundMin: 0.5, handoverMin: 0.8, lookaheadMin: 2, maxTransferMin: 6 };
const BIG = 1e6;

export function predictedDelivery(o: Order, c: Courier, now: number, band: string): number {
  const start = Math.max(now, c.availableAt);
  const transfer = c.store === o.store ? 0 : tt.storeToStore[band][c.store][o.store];
  const pickup = Math.max(start + transfer, o.readyAt);
  return pickup + tt.travel[band][o.store][o.cell] + PARAMS.handoverMin;
}
function score(o: Order, deliveredAt: number) {
  const age = deliveredAt - o.placedAt;
  return age + PARAMS.latePenalty * Math.max(0, age - o.promiseMin);
}

export function costMatrix(req: AssignRequest) {
  const couriers = req.couriers.filter((c) => c.availableAt <= req.now + PARAMS.lookaheadMin);
  const pairCost = (o: Order, c: Courier, at: number) => {
    if (c.store !== o.store && tt.storeToStore[req.band][c.store][o.store] > PARAMS.maxTransferMin) return BIG;
    return score(o, predictedDelivery(o, c, at, req.band)) + (c.store !== o.store ? PARAMS.transferPenalty : 0);
  };
  const rows = req.orders.map((o, i) => {
    const now = couriers.map((c) => pairCost(o, c, req.now));
    // cost of deferring: best achievable score if the order waits one more round, plus a deferral penalty
    const later = Math.min(...couriers.map((c) => pairCost(o, c, req.now + PARAMS.roundMin)), BIG);
    const defer = req.orders.map((_, j) => (j === i ? (later < BIG ? later + PARAMS.deferPenalty : 0) : BIG));
    return [...now, ...defer];
  });
  return { couriers, rows };
}

export async function assign(req: AssignRequest, solverUrl = process.env.SOLVER_URL ?? "http://127.0.0.1:5001"): Promise<Assignment[]> {
  if (req.orders.length === 0 || req.couriers.length === 0) return [];
  const { couriers, rows } = costMatrix(req);
  if (couriers.length === 0) return [];
  const res = await fetch(`${solverUrl}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ costs: rows, big: BIG }) });
  if (!res.ok) throw new Error(`solver ${res.status}: ${await res.text()}`);
  const { assignment } = (await res.json()) as { assignment: number[] };
  const out: Assignment[] = [];
  assignment.forEach((col, i) => {
    if (col < 0 || col >= couriers.length) return; // deferred
    const o = req.orders[i], c = couriers[col];
    out.push({ orderId: o.id, courierId: c.id, startAt: Math.max(req.now, c.availableAt), predictedDeliveredAt: predictedDelivery(o, c, req.now, req.band) });
  });
  return out;
}
