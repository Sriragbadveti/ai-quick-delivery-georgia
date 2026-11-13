// Prints the size of every store's 7-minute zone for the midday and evening-peak bands.
import { readFileSync } from "node:fs";
const z = JSON.parse(readFileSync(new URL("../data/generated/zones_summary.json", import.meta.url)));
console.log(`travel-time provider: ${z.provider}`);
console.log("store      band           cells  residents   km2");
for (const p of z.summary.filter((p) => ["midday", "evening_peak"].includes(p.band)))
  console.log(`${p.store.padEnd(10)} ${p.band.padEnd(13)} ${String(p.cells).padStart(6)} ${String(p.residents).padStart(10)} ${p.areaKm2.toFixed(2).padStart(6)}`);
