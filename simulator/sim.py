"""Discrete-event simulation (SimPy) of a day of dark-store deliveries in Tbilisi.

Orders arrive at H3 cells according to the scenario's expected demand, are picked at their dark store,
assigned to couriers and delivered. Travel times come from the stored road-network travel table.
The simulator calls the real services through REST:
  - promise engine   (POST /promise/batch)  for every order's delivery promise
  - allocation       (POST /assign)         every 30 s in the "ai" policy (which calls the OR-Tools solver)
Policies:
  baseline: when an order is ready it goes to the first idle courier of its own store (FIFO queue).
  ai:       every 30 s, all waiting orders and available couriers of all stores are assigned optimally.
Staffing:
  fixed:    couriers per store-hour from the historical average for that type of day.
  forecast: couriers per store-hour from the TensorFlow.js forecast for that day, rescaled to the same
            total courier-hours as the fixed plan (so only the timing of capacity differs).
"""
from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

import requests
import simpy

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / "data" / "generated"
CITY = json.loads((ROOT / "config" / "city.json").read_text())
TT = json.loads((GEN / "travel_times.json").read_text())
SC = json.loads((GEN / "scenarios.json").read_text())
FC = json.loads((GEN / "forecast_store_hour.json").read_text())
HIST = json.loads((GEN / "demand_history.json").read_text())

OPEN_H, CLOSE_H = CITY["operatingHours"]
SLOT = 15
ROUND = 0.5           # minutes between allocation rounds
HANDOVER = (0.8, 0.2)
PICK_MEDIAN, PICK_SIGMA = 1.4, 0.3
TRAVEL_SIGMA = 0.18
TARGET_UTIL = 0.8
PROMISE_URL = "http://127.0.0.1:4002"
ALLOC_URL = "http://127.0.0.1:4003"
session = requests.Session()


def band_for(minute: float, weekend: bool) -> str:
    if weekend:
        return "weekend"
    h = int(minute // 60)
    for name, b in CITY["timeBands"].items():
        if b["hours"][0] <= h < b["hours"][1]:
            return name
    return "night"


@dataclass
class Order:
    id: str
    store: str
    cell: str
    placed: float
    ready: float = 0.0
    promise: float = 10.0
    ten_offered: bool = False
    assigned: bool = False
    depart: float | None = None
    delivered: float | None = None
    courier_store: str | None = None


@dataclass
class Courier:
    id: str
    home: str
    available_at: float
    active: bool = True
    retiring: bool = False
    busy_minutes: float = 0.0
    active_since: float = 0.0
    active_minutes: float = 0.0
    trips: int = 0


@dataclass
class Result:
    orders: list[Order] = field(default_factory=list)
    couriers: list[Courier] = field(default_factory=list)


def stores() -> list[str]:
    return sorted({c["store"] for c in SC["cells"]})


def mean_cycle_minutes(store: str, lam: list[list[float]], band: str) -> float:
    """Average round trip (out + back + handover) for this store's demand mix in a time band."""
    num = den = 0.0
    for i, c in enumerate(SC["cells"]):
        if c["store"] != store:
            continue
        w = sum(lam[i])
        num += w * (2 * TT["travel"][band][store][c["cell"]] + HANDOVER[0])
        den += w
    return num / den


def staffing_from_orders(orders_per_hour: list[float], cycles: list[float]) -> list[int]:
    return [max(2, math.ceil(o * cyc / 60 / TARGET_UTIL)) for o, cyc in zip(orders_per_hour, cycles)]


def historical_profile(store: str, weekend: bool) -> list[float]:
    """Mean orders per hour for this store over the training weeks for this type of day."""
    idx = [i for i, c in enumerate(HIST["cells"]) if c["store"] == store]
    hours = (CLOSE_H - OPEN_H)
    sums, n = [0.0] * hours, 0
    for d, day in enumerate(HIST["days"]):
        if day["date"] >= "2025-10-06" or day["holiday"]:
            continue
        is_we = day["dow"] in (0, 6)
        if is_we != weekend:
            continue
        n += 1
        for i in idx:
            row = HIST["counts"][d][i]
            for k, v in enumerate(row):
                sums[k // 4] += v
    return [s / n for s in sums]


def rescale_to_hours(plan: list[int], total: int) -> list[int]:
    """Scale a staffing plan to a given total of courier-hours (largest remainder, minimum 2)."""
    raw = [p * total / sum(plan) for p in plan]
    out = [max(2, math.floor(x)) for x in raw]
    rem = total - sum(out)
    order = sorted(range(len(raw)), key=lambda j: raw[j] - math.floor(raw[j]), reverse=True)
    j = 0
    while rem > 0:
        out[order[j % len(order)]] += 1
        rem -= 1
        j += 1
    while rem < 0:
        k = max(range(len(out)), key=lambda j: out[j])
        out[k] -= 1
        rem += 1
    return out


def staffing_plans(scenario: str) -> dict[str, dict[str, list[int]]]:
    s = SC["scenarios"][scenario]
    weekend = s["day"]["dow"] in (0, 6) or s["day"]["holiday"] is not None
    plans: dict[str, dict[str, list[int]]] = {"fixed": {}, "forecast": {}}
    for st in stores():
        cyc = [mean_cycle_minutes(st, s["lambda"], band_for(h * 60, weekend)) for h in range(OPEN_H, CLOSE_H)]
        fixed = staffing_from_orders(historical_profile(st, weekend), cyc)
        fc = staffing_from_orders(FC["series"][s["date"]][st]["model"], cyc)
        plans["fixed"][st] = fixed
        plans["forecast"][st] = rescale_to_hours(fc, sum(fixed))
    return plans


def sample_orders(scenario: str, seed: int) -> list[Order]:
    s = SC["scenarios"][scenario]
    rnd = random.Random(seed)
    effect = {st: math.exp(rnd.gauss(0, 0.08)) for st in stores()}
    out: list[Order] = []
    n = 0
    for i, c in enumerate(SC["cells"]):
        for k, lam in enumerate(s["lambda"][i]):
            m = poisson(lam * effect[c["store"]], rnd)
            for _ in range(m):
                t = OPEN_H * 60 + k * SLOT + rnd.random() * SLOT
                out.append(Order(id=f"o{n}", store=c["store"], cell=c["cell"], placed=t))
                n += 1
    out.sort(key=lambda o: o.placed)
    return out


def poisson(lam: float, rnd: random.Random) -> int:
    if lam <= 0:
        return 0
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        k += 1
        p *= rnd.random()
        if p <= L:
            return k - 1


def run(scenario: str, policy: str, staffing: str, seed: int) -> dict:
    s = SC["scenarios"][scenario]
    weekend = s["day"]["dow"] in (0, 6) or s["day"]["holiday"] is not None
    plans = staffing_plans(scenario)[staffing]
    orders = sample_orders(scenario, seed)
    rnd = random.Random(seed * 7919 + 1)  # service-time randomness, identical across policies for a seed
    for o in orders:
        o.ready = o.placed + PICK_MEDIAN * math.exp(PICK_SIGMA * rnd.gauss(0, 1))
    ride_noise = {o.id: (math.exp(TRAVEL_SIGMA * rnd.gauss(0, 1)), math.exp(TRAVEL_SIGMA * rnd.gauss(0, 1)), max(0.2, rnd.gauss(*HANDOVER))) for o in orders}

    env = simpy.Environment(initial_time=OPEN_H * 60)
    couriers: list[Courier] = []
    queue: dict[str, list[Order]] = {st: [] for st in stores()}
    waiting: list[Order] = []  # placed, not yet assigned (ai policy)

    def active(st: str) -> list[Courier]:
        return [c for c in couriers if c.home == st and c.active]

    def set_staff(st: str, target: int, now: float):
        cur = [c for c in active(st) if not c.retiring]
        if len(cur) < target:
            # bring back retiring or off-shift couriers first, then add new ones
            for c in [c for c in couriers if c.home == st and c.active and c.retiring][: target - len(cur)]:
                c.retiring = False
                cur.append(c)
            for c in [c for c in couriers if c.home == st and not c.active][: target - len(cur)]:
                c.active, c.retiring, c.available_at, c.active_since = True, False, max(now, c.available_at), now
                cur.append(c)
            while len(cur) < target:
                c = Courier(id=f"{st}-{len(couriers)}", home=st, available_at=now, active_since=now)
                couriers.append(c)
                cur.append(c)
        elif len(cur) > target:
            for c in sorted(cur, key=lambda c: c.available_at)[: len(cur) - target]:
                if c.available_at <= now:
                    c.active = False
                    c.active_minutes += now - c.active_since
                else:
                    c.retiring = True

    def shift_manager():
        for h in range(OPEN_H, CLOSE_H):
            for st in stores():
                set_staff(st, plans[st][h - OPEN_H], env.now)
            yield env.timeout(60)

    def trip(c: Courier, o: Order, start: float):
        """Sample the whole trip once the courier is committed to the order."""
        b = band_for(start, weekend)
        t = start
        if c.home != o.store:
            t += TT["storeToStore"][b][c.home][o.store]
        depart = max(t, o.ready)
        n_out, n_back, hand = ride_noise[o.id]
        ride = TT["travel"][b][o.store][o.cell] * n_out
        o.depart, o.delivered, o.courier_store = depart, depart + ride + hand, c.home
        back = TT["travel"][b][c.home][o.cell] * n_back
        ret = o.delivered + back
        c.busy_minutes += ret - start
        c.available_at = ret
        c.trips += 1
        o.assigned = True
        return ret

    def courier_returns(c: Courier, at: float):
        yield env.timeout(max(0.0, at - env.now))
        if c.retiring:
            c.active, c.retiring = False, False
            c.active_minutes += env.now - c.active_since
            return
        if policy == "baseline":
            dispatch_baseline(c.home)

    def dispatch_baseline(st: str):
        idle = [c for c in active(st) if not c.retiring and c.available_at <= env.now + 1e-9]
        while idle and queue[st]:
            c = idle.pop(0)
            o = queue[st].pop(0)
            ret = trip(c, o, env.now)
            env.process(courier_returns(c, ret))

    def expected_wait(st: str, now: float) -> float:
        ready_at = now + PICK_MEDIAN
        q = len(queue[st]) if policy == "baseline" else sum(1 for o in waiting if o.store == st)
        avail = sorted(max(c.available_at, ready_at) for c in active(st) if not c.retiring)
        if q < len(avail):
            return max(0.0, avail[q] - ready_at)
        return 10.0

    def arrivals():
        i = 0
        while i < len(orders):
            # group orders placed within the same simulated minute into one promise batch
            t0 = orders[i].placed
            yield env.timeout(max(0.0, t0 - env.now))
            batch = []
            while i < len(orders) and orders[i].placed < t0 + 1.0:
                batch.append(orders[i])
                i += 1
            b = band_for(env.now, weekend)
            reqs = [{"store": o.store, "cell": o.cell, "band": b, "expectedWaitMin": round(expected_wait(o.store, env.now), 2)} for o in batch]
            res = session.post(f"{PROMISE_URL}/promise/batch", json={"requests": reqs}, timeout=30).json()
            for o, r in zip(batch, res):
                o.promise, o.ten_offered = r["promisedMinutes"], r["tenMinute"]
                if policy == "baseline":
                    env.process(ready_then_queue(o))
                else:
                    waiting.append(o)

    def ready_then_queue(o: Order):
        yield env.timeout(max(0.0, o.ready - env.now))
        queue[o.store].append(o)
        dispatch_baseline(o.store)

    def allocator():
        end = CLOSE_H * 60 + 120
        while env.now < end:
            if waiting:
                now = env.now
                b = band_for(now, weekend)
                cs = [c for c in couriers if c.active and not c.retiring and c.available_at <= now + 2]
                if cs:
                    payload = {
                        "now": now, "band": b,
                        "orders": [{"id": o.id, "store": o.store, "cell": o.cell, "placedAt": o.placed, "readyAt": o.ready, "promiseMin": o.promise} for o in waiting],
                        "couriers": [{"id": c.id, "store": c.home, "availableAt": c.available_at} for c in cs],
                    }
                    res = session.post(f"{ALLOC_URL}/assign", json=payload, timeout=60).json()
                    by_o = {o.id: o for o in waiting}
                    by_c = {c.id: c for c in cs}
                    for a in res["assignments"]:
                        o, c = by_o[a["orderId"]], by_c[a["courierId"]]
                        ret = trip(c, o, max(now, c.available_at))
                        env.process(courier_returns(c, ret))
                    done = {a["orderId"] for a in res["assignments"]}
                    waiting[:] = [o for o in waiting if o.id not in done]
            yield env.timeout(ROUND)

    env.process(shift_manager())
    env.process(arrivals())
    if policy == "ai":
        env.process(allocator())
    env.run(until=CLOSE_H * 60 + 180)
    for c in couriers:
        if c.active:
            c.active_minutes += min(env.now, CLOSE_H * 60) - c.active_since
    return summarise(scenario, policy, staffing, seed, orders, couriers)


def pct(xs: list[float], q: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(q * len(s)))] if s else float("nan")


def summarise(scenario, policy, staffing, seed, orders, couriers) -> dict:
    done = [o for o in orders if o.delivered is not None]
    dt = [o.delivered - o.placed for o in done]
    peak = [o.delivered - o.placed for o in done if o.placed >= 17 * 60 and o.placed < 21 * 60]
    hours = sum(c.active_minutes for c in couriers) / 60
    return {
        "scenario": scenario, "policy": policy, "staffing": staffing, "seed": seed,
        "orders": len(orders), "delivered": len(done),
        "on_time_10": sum(1 for x in dt if x <= 10) / len(dt),
        "on_time_10_peak": sum(1 for x in peak if x <= 10) / max(1, len(peak)),
        "mean_min": sum(dt) / len(dt), "p90_min": pct(dt, 0.9),
        "ten_offered": sum(o.ten_offered for o in orders) / len(orders),
        "promise_kept": sum(1 for o in done if o.delivered - o.placed <= o.promise) / len(done),
        "ten_kept": sum(1 for o in done if o.ten_offered and o.delivered - o.placed <= 10) / max(1, sum(1 for o in done if o.ten_offered)),
        "wait_for_courier_min": sum(o.depart - o.ready for o in done) / len(done),
        "cross_store_share": sum(1 for o in done if o.courier_store != o.store) / len(done),
        "courier_hours": round(hours, 1), "orders_per_courier_hour": len(done) / hours if hours else float("nan"),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="weekday", choices=list(SC["scenarios"].keys()))
    ap.add_argument("--policy", default="ai", choices=["baseline", "ai"])
    ap.add_argument("--staffing", default="fixed", choices=["fixed", "forecast"])
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    print(json.dumps(run(a.scenario, a.policy, a.staffing, a.seed), indent=2))
