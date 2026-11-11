"""Assignment solver service (FastAPI + Google OR-Tools).

POST /assign  {"costs": [[...], ...], "big": 1e6}
Rows are tasks (orders), columns are options (couriers or a "defer" option); rows <= columns.
Returns {"assignment": [col_for_row_0, ...]} minimising total cost, solved exactly with
OR-Tools' linear sum assignment (a Hungarian-type min-cost perfect matching).
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from ortools.graph.python import linear_sum_assignment

app = FastAPI(title="assignment-solver")
SCALE = 100  # OR-Tools works with integer costs


class AssignRequest(BaseModel):
    costs: list[list[float]]
    big: float = 1e6


def solve(costs: list[list[float]], big: float = 1e6) -> list[int]:
    n_rows = len(costs)
    if n_rows == 0:
        return []
    n_cols = len(costs[0])
    if n_rows > n_cols:
        raise ValueError("more rows than columns: add defer options")
    lsa = linear_sum_assignment.SimpleLinearSumAssignment()
    for i, row in enumerate(costs):
        for j, c in enumerate(row):
            if c < big:
                lsa.add_arc_with_cost(i, j, int(round(c * SCALE)))
    # pad with dummy rows so every column can be matched (perfect matching required)
    for d in range(n_rows, n_cols):
        for j in range(n_cols):
            lsa.add_arc_with_cost(d, j, 0)
    status = lsa.solve()
    if status != lsa.OPTIMAL:
        raise ValueError(f"no feasible assignment (status {status})")
    return [lsa.right_mate(i) for i in range(n_rows)]


@app.get("/health")
def health():
    return {"ok": True, "service": "solver"}


@app.post("/assign")
def assign(req: AssignRequest):
    try:
        return {"assignment": solve(req.costs, req.big)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
