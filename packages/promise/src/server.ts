import express from "express";
import { computePromise } from "./engine.ts";

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
const port = Number(process.env.PORT ?? 4002);
app.listen(port, () => console.log(`promise engine on :${port}`));
