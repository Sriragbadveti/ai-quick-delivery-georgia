"""Preliminary experiments.

E1 (H1): dispatch policy, baseline (nearest idle courier of the same store, FIFO) vs ai (optimised
         assignment every 30 s), fixed staffing, all four scenarios.
E3 (H3): staffing plan, fixed (historical average) vs forecast-driven (TensorFlow.js forecast, same total
         courier-hours), ai dispatch, rain and match scenarios.
Each configuration runs with the same seeds, so policies face identical orders (paired comparison).
Requires the services from scripts/run_services.sh.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics as st
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from sim import run

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"
METRICS = ["on_time_10", "on_time_10_peak", "mean_min", "p90_min", "promise_kept", "ten_kept", "wait_for_courier_min", "orders_per_courier_hour", "cross_store_share", "ten_offered"]


def job(args):
    return run(*args)


def ci95(xs):
    m = st.mean(xs)
    h = 1.96 * st.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else 0.0
    return m, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    seeds = range(a.seeds)
    configs = []
    for sc in ["weekday", "weekend", "rain", "match"]:
        for pol in ["baseline", "ai"]:
            configs += [(sc, pol, "fixed", s) for s in seeds]
    for sc in ["rain", "match"]:
        configs += [(sc, "ai", "forecast", s) for s in seeds]

    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        rows = list(ex.map(job, configs, chunksize=2))
    RES.mkdir(exist_ok=True)
    with open(RES / "sim_runs.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    def group(sc, pol, stf):
        return [r for r in rows if r["scenario"] == sc and r["policy"] == pol and r["staffing"] == stf]

    summary = {"seeds": a.seeds, "configs": {}, "paired": {}}
    for sc, pol, stf in sorted({(r["scenario"], r["policy"], r["staffing"]) for r in rows}):
        g = group(sc, pol, stf)
        summary["configs"][f"{sc}|{pol}|{stf}"] = {m: {"mean": ci95([r[m] for r in g])[0], "ci95": ci95([r[m] for r in g])[1]} for m in METRICS} | {"orders_mean": st.mean(r["orders"] for r in g)}

    def paired(a_rows, b_rows, m):
        d = [b[m] - x[m] for x, b in zip(sorted(a_rows, key=lambda r: r["seed"]), sorted(b_rows, key=lambda r: r["seed"]))]
        mean, h = ci95(d)
        return {"diff_mean": mean, "ci95": h, "b_better_runs": sum(1 for x in d if x > 0), "runs": len(d)}

    for sc in ["weekday", "weekend", "rain", "match"]:
        summary["paired"][f"E1|{sc}|ai-minus-baseline"] = {m: paired(group(sc, "baseline", "fixed"), group(sc, "ai", "fixed"), m) for m in ["on_time_10", "on_time_10_peak", "mean_min", "p90_min", "ten_kept"]}
    for sc in ["rain", "match"]:
        summary["paired"][f"E3|{sc}|forecast-minus-fixed"] = {m: paired(group(sc, "ai", "fixed"), group(sc, "ai", "forecast"), m) for m in ["on_time_10", "on_time_10_peak", "mean_min", "p90_min", "ten_kept"]}
    (RES / "sim_summary.json").write_text(json.dumps(summary, indent=2))
    for k, v in summary["paired"].items():
        print(k, {m: f"{x['diff_mean']:+.3f}±{x['ci95']:.3f}" for m, x in v.items()})


if __name__ == "__main__":
    main()
