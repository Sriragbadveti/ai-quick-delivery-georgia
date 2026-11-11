# AI-Powered Quick Food Delivery System in Georgia

Bachelor's project (University of Georgia, School of Science and Technology) by Sai Sri Rag Badveti, supervised by Bekar Meladze.

The project designs and evaluates a quick-commerce system for Tbilisi with a 10-minute delivery target. Speed comes from planning (stocking, staffing, routing and honest promises), not from couriers riding faster.

**Status:** preliminary prototype. It includes the core engine, simulation and first results. The customer, courier and operations apps are planned for the final stage.

## What is in the repository

| Part | Path | Technology |
|---|---|---|
| Service zones: H3 grid, road-network travel times, dark-store siting, zone polygons | `packages/geo` | TypeScript, h3-js, Turf.js, OpenStreetMap |
| Synthetic demand generator and demand forecasting | `packages/demand` | TypeScript, TensorFlow.js |
| Delivery promise engine (REST, port 4002) | `packages/promise` | TypeScript, Express |
| Order allocation service (REST, port 4003) | `packages/allocation` | TypeScript, Express |
| Assignment solver (REST, port 5001) | `solver` | Python, FastAPI, Google OR-Tools |
| Discrete-event simulator and experiments | `simulator` | Python, SimPy |
| Figures | `scripts/figures.py` | matplotlib |

## Data

- **Road network:** OpenStreetMap, extracted for Tbilisi from the Geofabrik Georgia file with `scripts/extract_tbilisi.py`. The extract is `data/raw/tbilisi_roads.csv.gz`. © OpenStreetMap contributors, ODbL.
- **Weather:** Open-Meteo historical hourly temperature and precipitation for Tbilisi, August to October 2025, in `data/raw/weather_tbilisi.csv` (CC BY 4.0).
- **Population:** district totals from the 2014 census, scaled to Geostat's 1 January 2026 total and spread over H3 cells. This is an approximation.
- **Orders:** synthetic. No delivery platform publishes order data, so orders are generated from population, time of day, weather, holidays and a match calendar. All parameters are in `packages/demand/src/model.ts`.

## Run it

```bash
npm install
pip install ortools simpy fastapi uvicorn numpy pandas matplotlib requests h3
npx tsx packages/geo/src/siteStores.ts       # choose dark-store locations (maximum coverage)
npx tsx packages/geo/src/buildZones.ts       # zones and travel-time tables
npx tsx packages/demand/src/generate.ts      # 12 weeks of order history and scenario days
npx tsx packages/demand/src/forecast.ts      # train and evaluate the TensorFlow.js forecaster
./scripts/run_services.sh                    # promise engine, allocation service, OR-Tools solver
cd simulator && python3 experiments.py --seeds 20
python3 scripts/figures.py
```

Tests: `npx tsx --test packages/promise/src/engine.test.ts` and `cd solver && python3 -m pytest -q`.

## Limitations (preliminary stage)

- Travel times use free-flow speeds by road class and assumed congestion factors per time band. There is no live traffic or elevation data yet; Google Routes API traffic-aware times are planned.
- Orders are synthetic, so results show how the methods behave under stated assumptions. They are not measurements of a real service.
- Batching of two orders per courier and the PostgreSQL/PostGIS backend are planned for the final stage.
