import express from "express";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cellToBoundary } from "h3-js";
import { computePromise } from "./engine.ts";
import { GENERATED, ROOT } from "../../geo/src/config.ts";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "promise" }));
app.post("/promise", (req, res) => {
  try { res.json(computePromise(req.body)); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
// batch endpoint used by the simulator to avoid one HTTP call per order
app.post("/promise/batch", (req, res) => {
  try { res.json((req.body.requests as unknown[]).map((r) => computePromise(r as never))); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
// Data for the operations demo page: zone polygons, served cells with their hexagon outlines, stores.
app.get("/zones", (_req, res) => {
  const zones = JSON.parse(readFileSync(resolve(GENERATED, "zones.geojson"), "utf8"));
  const cells = JSON.parse(readFileSync(resolve(GENERATED, "cells.json"), "utf8"));
  const sited = JSON.parse(readFileSync(resolve(ROOT, "config/stores.sited.json"), "utf8"));
  const served = new Set<string>(Object.values(cells.zoneCells.midday as Record<string, string[]>).flat());
  res.json({
    zones,
    stores: sited.stores,
    cells: cells.cells.filter((c: { cell: string }) => served.has(c.cell)).map((c: { cell: string; store: string; population: number }) => ({
      cell: c.cell, store: c.store, population: c.population, boundary: cellToBoundary(c.cell).map(([la, ln]) => [ln, la]),
    })),
  });
});
app.get("/demo", (_req, res) => res.sendFile(resolve(dirname(fileURLToPath(import.meta.url)), "demo.html")));
const port = Number(process.env.PORT ?? 4002);
app.listen(port, () => console.log(`promise engine on :${port}`));
