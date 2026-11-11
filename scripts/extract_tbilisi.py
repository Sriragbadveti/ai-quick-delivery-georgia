import osmium, gzip, sys
S, W, N, E = 41.63, 44.69, 41.83, 44.93
KEEP = {"motorway","trunk","primary","secondary","tertiary","unclassified","residential","living_street","service",
        "motorway_link","trunk_link","primary_link","secondary_link","tertiary_link","road"}
class H(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__(); self.out = out; self.n = 0
    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in KEEP: return
        if w.tags.get("access") in ("private", "no"): return
        pts = []
        for nd in w.nodes:
            if not nd.location.valid(): return
            pts.append((nd.ref, nd.location.lat, nd.location.lon))
        if not any(S <= la <= N and W <= lo <= E for _, la, lo in pts): return
        oneway = w.tags.get("oneway", "no"); ms = w.tags.get("maxspeed", "")
        coords = ";".join(f"{r}:{la:.6f}:{lo:.6f}" for r, la, lo in pts)
        self.out.write(f"{w.id},{hw},{oneway},{ms},{coords}\n"); self.n += 1
with gzip.open("tbilisi_roads.csv.gz", "wt") as f:
    f.write("way_id,highway,oneway,maxspeed,nodes\n")
    h = H(f); h.apply_file(sys.argv[1], locations=True, idx="flex_mem")
print("ways", h.n)
