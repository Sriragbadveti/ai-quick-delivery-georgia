"""Figures for the preliminary report (written to results/figures/)."""
import gzip
import json
from pathlib import Path

import h3
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection, PolyCollection
import matplotlib.patheffects as pe

ROOT = Path(__file__).resolve().parents[1]
GEN, RES, FIG = ROOT / "data/generated", ROOT / "results", ROOT / "results/figures"
FIG.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({"font.family": "DejaVu Serif", "font.size": 10})
COL = {"isani": "#1b6ca8", "saburtalo": "#b3152b", "vake": "#2e7d32"}
city = json.loads((ROOT / "config/city.json").read_text())
sited = json.loads((ROOT / "config/stores.sited.json").read_text())


def road_segments(major_only=False):
    segs, lw = [], []
    keep_major = {"motorway", "trunk", "primary", "secondary", "tertiary"}
    with gzip.open(ROOT / "data/raw/tbilisi_roads.csv.gz", "rt") as f:
        next(f)
        for line in f:
            _, hw, _, _, nodes = line.rstrip("\n").split(",", 4)
            if major_only and hw not in keep_major:
                continue
            if hw == "service":
                continue
            pts = [(float(p.split(":")[2]), float(p.split(":")[1])) for p in nodes.split(";")]
            segs.append(pts)
            lw.append(0.9 if hw in keep_major else 0.25)
    return segs, lw


def fig_zones():
    zones = json.loads((GEN / "zones.geojson").read_text())
    cells = json.loads((GEN / "cells.json").read_text())
    fig, ax = plt.subplots(figsize=(7.2, 6.2))
    segs, lw = road_segments()
    ax.add_collection(LineCollection(segs, linewidths=lw, colors="#9aa3ad", zorder=1))
    # population per hexagon (served cells only)
    served = {c["cell"]: c for c in cells["cells"]}
    polys, vals = [], []
    zone_cells = set(sum(cells["zoneCells"]["midday"].values(), []))
    for cid in zone_cells:
        b = h3.cell_to_boundary(cid)
        polys.append([(lng, lat) for lat, lng in b])
        vals.append(served[cid]["population"])
    pc = PolyCollection(polys, array=vals, cmap="Oranges", edgecolors="white", linewidths=0.3, alpha=0.75, zorder=2)
    ax.add_collection(pc)
    for f in zones["features"]:
        p = f["properties"]
        if p["band"] not in ("midday", "evening_peak"):
            continue
        geoms = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
        for poly in geoms:
            xs, ys = zip(*poly[0])
            ax.plot(xs, ys, color=COL[p["store"]], lw=2.0 if p["band"] == "midday" else 1.4, ls="-" if p["band"] == "midday" else "--", zorder=3)
    for s in sited["stores"]:
        ax.plot(s["lng"], s["lat"], marker="h", ms=13, color=COL[s["id"]], mec="white", mew=1.5, zorder=4)
        ax.annotate(s["name"], (s["lng"], s["lat"]), xytext=(7, 7), textcoords="offset points", fontsize=10, weight="bold", color=COL[s["id"]], zorder=5, path_effects=[pe.withStroke(linewidth=3, foreground="white")])
    st = city["stadium"]
    ax.plot(st["lng"], st["lat"], marker="*", ms=14, color="black", zorder=4)
    ax.annotate("Dinamo Arena", (st["lng"], st["lat"]), xytext=(6, -12), textcoords="offset points", fontsize=9)
    ax.set_xlim(44.70, 44.90); ax.set_ylim(41.655, 41.775); ax.set_aspect(1 / 0.746)
    ax.set_xlabel("Longitude"); ax.set_ylabel("Latitude")
    cb = fig.colorbar(pc, ax=ax, shrink=0.7); cb.set_label("Residents per hexagon (approx.)")
    ax.plot([], [], color="black", lw=2, label="7-min zone, midday"); ax.plot([], [], color="black", lw=1.4, ls="--", label="7-min zone, evening peak")
    ax.legend(loc="lower left", fontsize=8, framealpha=0.9)
    fig.tight_layout(); fig.savefig(FIG / "zones_map.png", dpi=220); plt.close(fig)


def fig_forecast():
    fc = json.loads((GEN / "forecast_store_hour.json").read_text())
    oh = fc["openHour"]
    fig, axes = plt.subplots(1, 2, figsize=(7.4, 2.9), sharey=True)
    for ax, date, title in zip(axes, ["2025-10-21", "2025-10-15"], ["Normal weekday (21 Oct 2025)", "Match day (15 Oct 2025)"]):
        tot = {k: [sum(fc["series"][date][s][k][h] for s in fc["series"][date]) for h in range(16)] for k in ("actual", "model", "naive")}
        hours = list(range(oh, oh + 16))
        ax.plot(hours, tot["actual"], color="black", lw=2, label="Actual")
        ax.plot(hours, tot["model"], color="#b3152b", lw=1.6, label="Neural network")
        ax.plot(hours, tot["naive"], color="#8c9bb5", lw=1.4, ls="--", label="Same time last week")
        if date == "2025-10-15":
            ax.axvline(20, color="grey", lw=0.8, ls=":"); ax.text(20.1, max(tot["actual"]) * 0.95, "kick-off", fontsize=8, color="grey")
        ax.set_title(title, fontsize=10); ax.set_xlabel("Hour of day")
    axes[0].set_ylabel("Orders per hour (3 stores)")
    axes[0].legend(fontsize=8, frameon=False)
    fig.tight_layout(); fig.savefig(FIG / "forecast_days.png", dpi=220); plt.close(fig)


def fig_results():
    s = json.loads((RES / "sim_summary.json").read_text())
    sc = ["weekday", "weekend", "rain", "match"]
    labels = ["Weekday", "Weekend", "Rain", "Match day"]
    fig, ax = plt.subplots(figsize=(6.6, 3.0))
    w = 0.36
    for j, (pol, col, lab) in enumerate([("baseline", "#8c9bb5", "Nearest courier (baseline)"), ("ai", "#14213d", "Optimised assignment")]):
        m = [100 * s["configs"][f"{x}|{pol}|fixed"]["on_time_10"]["mean"] for x in sc]
        e = [100 * s["configs"][f"{x}|{pol}|fixed"]["on_time_10"]["ci95"] for x in sc]
        xs = [i + (j - 0.5) * w for i in range(len(sc))]
        ax.bar(xs, m, w, yerr=e, color=col, label=lab, capsize=3)
        for x, v in zip(xs, m):
            ax.text(x, v + 1.2, f"{v:.1f}", ha="center", fontsize=8)
    ax.set_xticks(range(len(sc))); ax.set_xticklabels(labels)
    ax.set_ylabel("Orders delivered within 10 min (%)"); ax.set_ylim(0, 100)
    ax.legend(fontsize=8, frameon=False, loc="upper right")
    fig.tight_layout(); fig.savefig(FIG / "sim_on_time.png", dpi=220); plt.close(fig)


if __name__ == "__main__":
    fig_zones(); fig_forecast()
    if (RES / "sim_summary.json").exists():
        fig_results()
    print("figures written to", FIG)
