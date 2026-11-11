import { test } from "node:test";
import assert from "node:assert/strict";
import { computePromise } from "./engine.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GENERATED } from "../../geo/src/config.ts";

const cells = JSON.parse(readFileSync(resolve(GENERATED, "cells.json"), "utf8"));
const store = Object.keys(cells.zoneCells.midday)[0];
const inZone: string[] = cells.zoneCells.midday[store];
const travel = JSON.parse(readFileSync(resolve(GENERATED, "travel_times.json"), "utf8")).travel.midday[store];
const near = [...inZone].sort((a, b) => travel[a] - travel[b])[0];

test("near address with a free courier gets the 10-minute promise", () => {
  const r = computePromise({ store, cell: near, band: "midday", expectedWaitMin: 0 });
  assert.equal(r.tenMinute, true);
  assert.equal(r.promisedMinutes, 10);
  assert.ok(r.p90 <= 10);
});

test("long expected wait removes the 10-minute promise and rounds up to 5-minute steps", () => {
  const r = computePromise({ store, cell: near, band: "midday", expectedWaitMin: 9 });
  assert.equal(r.tenMinute, false);
  assert.equal(r.promisedMinutes % 5, 0);
  assert.ok(r.promisedMinutes >= r.p90);
});

test("promise is deterministic for the same inputs", () => {
  const a = computePromise({ store, cell: near, band: "evening_peak", expectedWaitMin: 2 });
  const b = computePromise({ store, cell: near, band: "evening_peak", expectedWaitMin: 2 });
  assert.deepEqual(a, b);
});
