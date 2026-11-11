import express from "express";
import { assign } from "./assign.ts";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "allocation" }));
app.post("/assign", async (req, res) => {
  try { res.json({ assignments: await assign(req.body) }); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
const port = Number(process.env.PORT ?? 4003);
app.listen(port, () => console.log(`allocation service on :${port}`));
