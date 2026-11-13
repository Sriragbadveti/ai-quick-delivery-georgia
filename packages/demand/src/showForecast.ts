/**
 * Prints the hourly forecast for one store and one test day next to the actual orders and the
 * seasonal naive forecast. Usage: npx tsx packages/demand/src/showForecast.ts 2025-10-15 isani
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED } from "../../geo/src/config.ts";

const [date = "2025-10-15", store = "isani"] = process.argv.slice(2);
const fc = JSON.parse(readFileSync(resolve(GENERATED, "forecast_store_hour.json"), "utf8"));
const s = fc.series[date]?.[store];
if (!s) { console.error(`no forecast for ${date}/${store}`); process.exit(1); }
console.log(`Forecast for store "${store}" on ${date} (orders per hour)`);
console.log("hour   actual   network   naive");
let ae = 0, an = 0, tot = 0;
s.actual.forEach((a: number, h: number) => {
  const m = s.model[h], n = s.naive[h];
  ae += Math.abs(a - m); an += Math.abs(a - n); tot += a;
  console.log(`${String(fc.openHour + h).padStart(2, "0")}:00 ${a.toFixed(0).padStart(7)} ${m.toFixed(1).padStart(9)} ${n.toFixed(0).padStart(7)}`);
});
console.log(`WAPE  network ${(100 * ae / tot).toFixed(1)}%   naive ${(100 * an / tot).toFixed(1)}%`);
