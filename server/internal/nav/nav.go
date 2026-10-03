// Package nav provides deterministic static navigation for server-side bot scripts.
package nav

import (
	"math"
	"sync"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

const (
	cellSize      = 1.0
	boundedMin    = -80.0
	boundedMax    = 80.0
	legacyMin     = -96.0
	legacyMax     = 96.0
	arenaRadius   = 80.0 - sim.RobotRadius
	arrivalRadius = 0.05
	maxExpansions = 8192
)

type wallSig struct {
	id       uint32
	minXBits uint64
	minYBits uint64
	maxXBits uint64
	maxYBits uint64
}

type signature struct {
	hash         uint64
	generatorVer int
	coreBits     uint64
	unlockPhase  sim.Phase
	locked       bool
	walls        []wallSig
}

type cacheBucket struct {
	mu    sync.Mutex
	grids []*grid
}

var grids sync.Map // map[uint64]*cacheBucket; exact signatures are verified inside each bucket.

type grid struct {
	sig       signature
	min       float64
	w, h      int
	valid     []bool
	validIDs  []int
	neighbors []int32
	routes    sync.Map // map[uint64][]int32, goal-to-start path for a snapped cell pair.
	pool      sync.Pool
}

type workspace struct {
	generation uint32
	seen       []uint32
	closed     []uint32
	g          []float64
	parent     []int32
	heap       []heapNode
	path       []int32
}

type heapNode struct {
	id int
	f  float64
	h  float64
}

// Direction returns the unit movement direction for a static path from from to target.
// A zero vector means the target is reached or no deterministic progress is available.
func Direction(m *sim.MapDef, phase sim.Phase, from, target sim.Vec2) sim.Vec2 {
	if !finiteVec(from) || !finiteVec(target) {
		return sim.Vec2{}
	}
	delta := target.Sub(from)
	if delta.Len() <= arrivalRadius {
		return sim.Vec2{}
	}
	locked := zoneLocked(m, phase)
	if pointFree(m, locked, target) && segmentFree(m, locked, from, target) {
		return unit(delta)
	}
	g := gridFor(m, locked)
	if g == nil || len(g.validIDs) == 0 {
		return sim.Vec2{}
	}
	start := g.nearestValid(from)
	goal := g.nearestValid(target)
	if start < 0 || goal < 0 {
		return sim.Vec2{}
	}
	w := g.pool.Get().(*workspace)
	defer g.pool.Put(w)
	key := uint64(uint32(start))<<32 | uint64(uint32(goal))
	var path []int32
	if cached, ok := g.routes.Load(key); ok {
		path = cached.([]int32)
	} else {
		best := g.search(w, start, goal)
		if best < 0 || best == start {
			return sim.Vec2{}
		}
		w.path = w.path[:0]
		for id := best; id >= 0; id = int(w.parent[id]) {
			w.path = append(w.path, int32(id))
			if id == start {
				break
			}
		}
		path = append([]int32(nil), w.path...)
		actual, _ := g.routes.LoadOrStore(key, path)
		path = actual.([]int32)
	}
	waypoint := g.point(int(path[0]))
	for i := 0; i < len(path); i++ {
		p := g.point(int(path[i]))
		if segmentFree(m, locked, from, p) {
			waypoint = p
			break
		}
	}
	return unit(waypoint.Sub(from))
}

func gridFor(m *sim.MapDef, locked bool) *grid {
	hash := signatureHash(m, locked)
	value, ok := grids.Load(hash)
	if !ok {
		value, _ = grids.LoadOrStore(hash, &cacheBucket{})
	}
	bucket := value.(*cacheBucket)
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	for _, g := range bucket.grids {
		if signatureMatches(g.sig, m, locked) {
			return g
		}
	}
	sig := captureSignature(m, locked, hash)
	g := buildGrid(m, sig)
	bucket.grids = append(bucket.grids, g)
	return g
}

func signatureHash(m *sim.MapDef, locked bool) uint64 {
	h := uint64(1469598103934665603)
	mix := func(v uint64) { h = (h ^ v) * 1099511628211 }
	if m != nil {
		mix(uint64(m.GeneratorVer))
		mix(math.Float64bits(m.CoreZone.Radius))
		mix(uint64(m.CoreZone.UnlockPhase))
	} else {
		mix(0)
		mix(0)
		mix(0)
	}
	if locked {
		mix(1)
	} else {
		mix(0)
	}
	if m != nil {
		for _, wall := range m.Walls {
			mix(uint64(wall.ID))
			mix(math.Float64bits(wall.Min.X))
			mix(math.Float64bits(wall.Min.Y))
			mix(math.Float64bits(wall.Max.X))
			mix(math.Float64bits(wall.Max.Y))
		}
	}
	return h
}

func captureSignature(m *sim.MapDef, locked bool, hash uint64) signature {
	s := signature{hash: hash, locked: locked}
	if m == nil {
		return s
	}
	s.generatorVer = m.GeneratorVer
	s.coreBits = math.Float64bits(m.CoreZone.Radius)
	s.unlockPhase = m.CoreZone.UnlockPhase
	s.walls = make([]wallSig, len(m.Walls))
	for i, wall := range m.Walls {
		s.walls[i] = wallSig{wall.ID, math.Float64bits(wall.Min.X), math.Float64bits(wall.Min.Y), math.Float64bits(wall.Max.X), math.Float64bits(wall.Max.Y)}
	}
	return s
}

func signatureMatches(s signature, m *sim.MapDef, locked bool) bool {
	if s.locked != locked {
		return false
	}
	if m == nil {
		return s.generatorVer == 0 && s.coreBits == 0 && s.unlockPhase == 0 && len(s.walls) == 0
	}
	if s.generatorVer != m.GeneratorVer || s.coreBits != math.Float64bits(m.CoreZone.Radius) || s.unlockPhase != m.CoreZone.UnlockPhase || len(s.walls) != len(m.Walls) {
		return false
	}
	for i, wall := range m.Walls {
		if s.walls[i] != (wallSig{wall.ID, math.Float64bits(wall.Min.X), math.Float64bits(wall.Min.Y), math.Float64bits(wall.Max.X), math.Float64bits(wall.Max.Y)}) {
			return false
		}
	}
	return true
}

func buildGrid(m *sim.MapDef, sig signature) *grid {
	gridMin, gridMax := legacyMin, legacyMax
	if m != nil && m.GeneratorVer >= 2 {
		gridMin, gridMax = boundedMin, boundedMax
	}
	w := int(math.Round((gridMax-gridMin)/cellSize)) + 1
	g := &grid{sig: sig, min: gridMin, w: w, h: w, valid: make([]bool, w*w), neighbors: make([]int32, w*w*4)}
	for i := range g.neighbors {
		g.neighbors[i] = -1
	}
	clearance := sim.RobotRadius + cellSize*math.Sqrt2/2
	for id := range g.valid {
		p := g.point(id)
		free := true
		if m != nil && m.GeneratorVer >= 2 && p.Len() > arenaRadius-cellSize*math.Sqrt2/2-1e-9 {
			free = false
		}
		if free && sig.locked && p.Len() < m.CoreZone.Radius+clearance+1e-9 {
			free = false
		}
		g.valid[id] = free
	}
	if m != nil {
		for _, wall := range m.Walls {
			minX := max(0, int(math.Floor((wall.Min.X-clearance-g.min)/cellSize)))
			maxX := min(g.w-1, int(math.Ceil((wall.Max.X+clearance-g.min)/cellSize)))
			minY := max(0, int(math.Floor((wall.Min.Y-clearance-g.min)/cellSize)))
			maxY := min(g.h-1, int(math.Ceil((wall.Max.Y+clearance-g.min)/cellSize)))
			for y := minY; y <= maxY; y++ {
				for x := minX; x <= maxX; x++ {
					id := y*g.w + x
					if g.valid[id] && pointRectDistanceSquared(g.point(id), wall.Min, wall.Max) <= clearance*clearance+1e-12 {
						g.valid[id] = false
					}
				}
			}
		}
	}
	for id, valid := range g.valid {
		if valid {
			g.validIDs = append(g.validIDs, id)
		}
	}
	dirs := [...]struct{ dx, dy int }{{1, 0}, {0, 1}, {-1, 0}, {0, -1}}
	for _, id := range g.validIDs {
		x, y := id%g.w, id/g.w
		for d, step := range dirs {
			nx, ny := x+step.dx, y+step.dy
			if nx < 0 || nx >= g.w || ny < 0 || ny >= g.h {
				continue
			}
			nid := ny*g.w + nx
			if g.valid[nid] {
				g.neighbors[id*4+d] = int32(nid)
			}
		}
	}
	g.pool.New = func() any {
		n := len(g.valid)
		return &workspace{seen: make([]uint32, n), closed: make([]uint32, n), g: make([]float64, n), parent: make([]int32, n), heap: make([]heapNode, 0, 512), path: make([]int32, 0, 256)}
	}
	return g
}

func (g *grid) point(id int) sim.Vec2 {
	return sim.Vec2{X: g.min + float64(id%g.w)*cellSize, Y: g.min + float64(id/g.w)*cellSize}
}

func (g *grid) nearestValid(p sim.Vec2) int {
	cx := int(math.Round((p.X - g.min) / cellSize))
	cy := int(math.Round((p.Y - g.min) / cellSize))
	cx = max(0, min(g.w-1, cx))
	cy = max(0, min(g.h-1, cy))
	best, bestD := -1, math.Inf(1)
	consider := func(x, y int) {
		if x < 0 || x >= g.w || y < 0 || y >= g.h {
			return
		}
		id := y*g.w + x
		if !g.valid[id] {
			return
		}
		q := g.point(id)
		dx, dy := q.X-p.X, q.Y-p.Y
		d := dx*dx + dy*dy
		if d < bestD-1e-12 || (math.Abs(d-bestD) <= 1e-12 && (best < 0 || id < best)) {
			best, bestD = id, d
		}
	}
	for radius := 0; radius < max(g.w, g.h); radius++ {
		if radius == 0 {
			consider(cx, cy)
		} else {
			for x := cx - radius; x <= cx+radius; x++ {
				consider(x, cy-radius)
				consider(x, cy+radius)
			}
			for y := cy - radius + 1; y < cy+radius; y++ {
				consider(cx-radius, y)
				consider(cx+radius, y)
			}
		}
		if best >= 0 && float64(radius)*cellSize > math.Sqrt(bestD)+cellSize {
			return best
		}
	}
	return best
}

func (g *grid) search(w *workspace, start, goal int) int {
	w.generation++
	if w.generation == 0 {
		clear(w.seen)
		clear(w.closed)
		w.generation = 1
	}
	gen := w.generation
	w.heap = w.heap[:0]
	w.seen[start] = gen
	w.g[start] = 0
	w.parent[start] = -1
	h := g.heuristic(start, goal)
	w.push(heapNode{id: start, f: h, h: h})
	best, bestH := start, h
	expanded := 0
	for len(w.heap) > 0 && expanded < maxExpansions {
		cur := w.pop()
		if w.closed[cur.id] == gen {
			continue
		}
		w.closed[cur.id] = gen
		expanded++
		if cur.h < bestH-1e-12 || (math.Abs(cur.h-bestH) <= 1e-12 && cur.id > best) {
			best, bestH = cur.id, cur.h
		}
		if cur.id == goal {
			return goal
		}
		for d := 0; d < 4; d++ {
			nid := int(g.neighbors[cur.id*4+d])
			if nid < 0 || w.closed[nid] == gen {
				continue
			}
			ng := w.g[cur.id] + 1
			if w.seen[nid] == gen && ng >= w.g[nid]-1e-12 {
				continue
			}
			w.seen[nid], w.g[nid], w.parent[nid] = gen, ng, int32(cur.id)
			nh := g.heuristic(nid, goal)
			w.push(heapNode{id: nid, f: ng + nh, h: nh})
		}
	}
	return best
}

func (g *grid) heuristic(a, b int) float64 {
	ax, ay := a%g.w, a/g.w
	bx, by := b%g.w, b/g.w
	dx, dy := math.Abs(float64(ax-bx)), math.Abs(float64(ay-by))
	return dx + dy
}

func (w *workspace) push(n heapNode) {
	w.heap = append(w.heap, n)
	for i := len(w.heap) - 1; i > 0; {
		p := (i - 1) / 2
		if !heapLess(w.heap[i], w.heap[p]) {
			break
		}
		w.heap[i], w.heap[p] = w.heap[p], w.heap[i]
		i = p
	}
}

func (w *workspace) pop() heapNode {
	out := w.heap[0]
	last := w.heap[len(w.heap)-1]
	w.heap = w.heap[:len(w.heap)-1]
	if len(w.heap) == 0 {
		return out
	}
	w.heap[0] = last
	for i := 0; ; {
		l, r, best := i*2+1, i*2+2, i
		if l < len(w.heap) && heapLess(w.heap[l], w.heap[best]) {
			best = l
		}
		if r < len(w.heap) && heapLess(w.heap[r], w.heap[best]) {
			best = r
		}
		if best == i {
			break
		}
		w.heap[i], w.heap[best] = w.heap[best], w.heap[i]
		i = best
	}
	return out
}

func heapLess(a, b heapNode) bool {
	if a.f != b.f {
		return a.f < b.f
	}
	if a.h != b.h {
		return a.h < b.h
	}
	return a.id > b.id
}

func zoneLocked(m *sim.MapDef, phase sim.Phase) bool {
	return m != nil && m.CoreZone.Radius > 0 && phase < m.CoreZone.UnlockPhase
}

func pointFree(m *sim.MapDef, locked bool, p sim.Vec2) bool {
	if !finiteVec(p) {
		return false
	}
	if m != nil && m.GeneratorVer >= 2 && p.Len() > arenaRadius-1e-9 {
		return false
	}
	if locked && p.Len() < m.CoreZone.Radius+sim.RobotRadius+1e-9 {
		return false
	}
	if m != nil {
		for _, wall := range m.Walls {
			if pointRectDistanceSquared(p, wall.Min, wall.Max) <= sim.RobotRadius*sim.RobotRadius+1e-12 {
				return false
			}
		}
	}
	return true
}

func segmentFree(m *sim.MapDef, locked bool, a, b sim.Vec2) bool {
	if !pointFree(m, locked, a) || !pointFree(m, locked, b) {
		return false
	}
	if locked && segmentPointDistanceSquared(a, b, sim.Vec2{}) <= square(m.CoreZone.Radius+sim.RobotRadius)+1e-12 {
		return false
	}
	if m != nil {
		for _, wall := range m.Walls {
			if segmentRectDistanceSquared(a, b, wall.Min, wall.Max) <= sim.RobotRadius*sim.RobotRadius+1e-12 {
				return false
			}
		}
	}
	return true
}

func segmentRectDistanceSquared(a, b, min, max sim.Vec2) float64 {
	if segmentIntersectsRect(a, b, min, max) {
		return 0
	}
	best := math.Min(pointRectDistanceSquared(a, min, max), pointRectDistanceSquared(b, min, max))
	corners := [...]sim.Vec2{min, {X: min.X, Y: max.Y}, {X: max.X, Y: min.Y}, max}
	edges := [...][2]sim.Vec2{{corners[0], corners[1]}, {corners[1], corners[3]}, {corners[3], corners[2]}, {corners[2], corners[0]}}
	for _, edge := range edges {
		best = math.Min(best, segmentSegmentDistanceSquared(a, b, edge[0], edge[1]))
	}
	return best
}

func segmentIntersectsRect(a, b, min, max sim.Vec2) bool {
	t0, t1 := 0.0, 1.0
	clip := func(p, q float64) bool {
		if p == 0 {
			return q >= 0
		}
		r := q / p
		if p < 0 {
			if r > t1 {
				return false
			}
			if r > t0 {
				t0 = r
			}
		} else {
			if r < t0 {
				return false
			}
			if r < t1 {
				t1 = r
			}
		}
		return true
	}
	dx, dy := b.X-a.X, b.Y-a.Y
	return clip(-dx, a.X-min.X) && clip(dx, max.X-a.X) && clip(-dy, a.Y-min.Y) && clip(dy, max.Y-a.Y)
}

func segmentSegmentDistanceSquared(a, b, c, d sim.Vec2) float64 {
	if segmentsIntersect(a, b, c, d) {
		return 0
	}
	return math.Min(math.Min(segmentPointDistanceSquared(a, b, c), segmentPointDistanceSquared(a, b, d)), math.Min(segmentPointDistanceSquared(c, d, a), segmentPointDistanceSquared(c, d, b)))
}

func segmentsIntersect(a, b, c, d sim.Vec2) bool {
	orient := func(p, q, r sim.Vec2) float64 { return (q.X-p.X)*(r.Y-p.Y) - (q.Y-p.Y)*(r.X-p.X) }
	o1, o2, o3, o4 := orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
	return ((o1 <= 0 && o2 >= 0) || (o1 >= 0 && o2 <= 0)) && ((o3 <= 0 && o4 >= 0) || (o3 >= 0 && o4 <= 0))
}

func pointRectDistanceSquared(p, min, max sim.Vec2) float64 {
	dx := math.Max(min.X-p.X, math.Max(0, p.X-max.X))
	dy := math.Max(min.Y-p.Y, math.Max(0, p.Y-max.Y))
	return dx*dx + dy*dy
}

func segmentPointDistanceSquared(a, b, p sim.Vec2) float64 {
	d := b.Sub(a)
	den := d.X*d.X + d.Y*d.Y
	if den == 0 {
		return square(p.Sub(a).Len())
	}
	t := ((p.X-a.X)*d.X + (p.Y-a.Y)*d.Y) / den
	t = math.Max(0, math.Min(1, t))
	q := a.Add(d.Scale(t))
	dx, dy := p.X-q.X, p.Y-q.Y
	return dx*dx + dy*dy
}

func unit(v sim.Vec2) sim.Vec2 {
	if n := v.Len(); n > 1e-12 {
		return v.Scale(1 / n)
	}
	return sim.Vec2{}
}

func finiteVec(v sim.Vec2) bool {
	return !math.IsNaN(v.X) && !math.IsNaN(v.Y) && !math.IsInf(v.X, 0) && !math.IsInf(v.Y, 0)
}
func square(v float64) float64 { return v * v }
