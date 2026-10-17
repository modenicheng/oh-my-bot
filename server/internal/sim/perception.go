package sim

import (
	"math"
	"slices"
	"sort"
	"sync"
)

const boundarySampleCount = 512

var (
	boundarySampleAngles  = makeBoundarySampleAngles()
	boundarySampleUnits   = makeBoundarySampleUnits()
	perceptionScratchPool = sync.Pool{New: func() any { return &perceptionScratch{} }}
)

type boundaryAngle struct {
	value  float64
	sample int // >= 0 for one of the fixed tessellation samples
}

type visibleArc struct{ start, end float64 }

// Only calculation scratch is pooled. Returned map geometry owns its backing
// arrays, so scripts and network encoders can retain observations across ticks.
type perceptionScratch struct {
	corners []Vec2
	dynamic []boundaryAngle
	angles  []boundaryAngle
	arcs    []visibleArc
}

func releasePerceptionScratch(scratch *perceptionScratch) {
	// Bound retained capacity for unusually large custom maps. Pool eviction
	// during GC remains safe: every call also works with a fresh empty scratch.
	if cap(scratch.corners) > 8192 || cap(scratch.dynamic) > 32768 || cap(scratch.angles) > 32768 || cap(scratch.arcs) > 8192 {
		return
	}
	scratch.corners = scratch.corners[:0]
	scratch.dynamic = scratch.dynamic[:0]
	scratch.angles = scratch.angles[:0]
	scratch.arcs = scratch.arcs[:0]
	perceptionScratchPool.Put(scratch)
}

func makeBoundarySampleAngles() [boundarySampleCount + 1]float64 {
	var out [boundarySampleCount + 1]float64
	for index := range out {
		out[index] = -math.Pi + 2*math.Pi*float64(index)/boundarySampleCount
	}
	return out
}

func makeBoundarySampleUnits() [boundarySampleCount + 1]Vec2 {
	var out [boundarySampleCount + 1]Vec2
	for index, angle := range boundarySampleAngles {
		sine, cosine := math.Sincos(angle)
		out[index] = Vec2{X: cosine, Y: sine}
	}
	return out
}

func (world WorldView) localMap(center Vec2, radius float64, visible, surfaceVisible func(Vec2, Vec2) bool, corners []Vec2, walls []Wall) *MapDef {
	local := &MapDef{Version: 1, Partial: true}
	source := world.Frame.Map
	if source == nil {
		return local
	}
	scratch := perceptionScratchPool.Get().(*perceptionScratch)
	defer releasePerceptionScratch(scratch)
	if walls == nil {
		walls = source.Walls
	}
	local.CoreZone.UnlockPhase = source.CoreZone.UnlockPhase
	for _, uplink := range source.Uplinks {
		if center.Sub(uplink.Pos).Len() <= radius && visible(center, uplink.Pos) {
			local.Uplinks = append(local.Uplinks, uplink)
		}
	}
	for _, pack := range source.HealthPacks {
		if center.Sub(pack.Pos).Len() <= radius && visible(center, pack.Pos) {
			local.HealthPacks = append(local.HealthPacks, pack)
		}
	}
	if len(source.CoreRules.SpawnBands) > 0 {
		for _, core := range world.Cores {
			if core.Alive && center.Sub(core.Pos).Len() <= radius && visible(center, core.Pos) {
				local.CorePads = append(local.CorePads, CorePadDef{ID: core.ID, Pos: core.Pos, Value: core.Value})
			}
		}
	} else {
		for _, pad := range source.CorePads {
			if center.Sub(pad.Pos).Len() <= radius && visible(center, pad.Pos) {
				local.CorePads = append(local.CorePads, pad)
			}
		}
	}
	if corners == nil {
		corners = scratch.corners[:0]
		for _, wall := range source.Walls {
			corners = append(corners, wall.Min, wall.Max, Vec2{wall.Min.X, wall.Max.Y}, Vec2{wall.Max.X, wall.Min.Y})
		}
		scratch.corners = corners
	}
	zone := source.CoreZone
	if zone.Radius > 0 && world.Frame.Phase < zone.UnlockPhase && center.Len() > zone.Radius {
		angle := math.Atan2(center.Y, center.X)
		offset := math.Acos(zone.Radius / center.Len())
		// Caller-supplied corners may have spare capacity and be shared by
		// parallel observers. Never append per-observer tangents into them.
		scratch.corners = append(scratch.corners[:0], corners...)
		corners = scratch.corners
		for _, direction := range []float64{angle - offset, angle + offset} {
			corners = append(corners, Vec2{math.Cos(direction) * zone.Radius, math.Sin(direction) * zone.Radius})
		}
		scratch.corners = corners
	}
	for _, wall := range walls {
		if center.X < wall.Min.X {
			local.Walls = append(local.Walls, visibleFace(center, radius, Vec2{wall.Min.X, wall.Min.Y}, Vec2{wall.Min.X, wall.Max.Y}, corners, visible)...)
		}
		if center.X > wall.Max.X {
			local.Walls = append(local.Walls, visibleFace(center, radius, Vec2{wall.Max.X, wall.Min.Y}, Vec2{wall.Max.X, wall.Max.Y}, corners, visible)...)
		}
		if center.Y < wall.Min.Y {
			local.Walls = append(local.Walls, visibleFace(center, radius, Vec2{wall.Min.X, wall.Min.Y}, Vec2{wall.Max.X, wall.Min.Y}, corners, visible)...)
		}
		if center.Y > wall.Max.Y {
			local.Walls = append(local.Walls, visibleFace(center, radius, Vec2{wall.Min.X, wall.Max.Y}, Vec2{wall.Max.X, wall.Max.Y}, corners, visible)...)
		}
	}
	for index := range local.Walls {
		local.Walls[index].ID = uint32(index + 1)
	}
	if source.GeneratorVer >= 2 {
		arenaRadius := source.ArenaRadius
		if arenaRadius <= 0 {
			arenaRadius = 80
		}
		local.Boundaries = append(local.Boundaries, world.visibleBoundary(center, radius, arenaRadius, "arena", corners, surfaceVisible, scratch)...)
	}
	if zone.Radius > 0 && world.Frame.Phase < zone.UnlockPhase {
		local.Boundaries = append(local.Boundaries, world.visibleBoundary(center, radius, zone.Radius, "lock", corners, surfaceVisible, scratch)...)
	}
	return local
}

func (world WorldView) visibleBoundary(center Vec2, radius, boundaryRadius float64, kind string, corners []Vec2, visible func(Vec2, Vec2) bool, scratch *perceptionScratch) []BoundaryEdge {
	if math.Abs(center.Len()-boundaryRadius) >= radius {
		return nil
	}
	dynamic := slices.Grow(scratch.dynamic[:0], 2+len(corners)*2)
	if distance := center.Len(); distance > 0 {
		cosine := (distance*distance + boundaryRadius*boundaryRadius - radius*radius) / (2 * distance * boundaryRadius)
		if cosine > -1 && cosine < 1 {
			base, offset := math.Atan2(center.Y, center.X), math.Acos(cosine)
			for _, angle := range []float64{base - offset, base + offset} {
				dynamic = append(dynamic, boundaryAngle{value: math.Atan2(math.Sin(angle), math.Cos(angle)), sample: -1})
			}
		}
	}
	for _, corner := range corners {
		ray := corner.Sub(center)
		lengthSquared := ray.X*ray.X + ray.Y*ray.Y
		if lengthSquared == 0 {
			continue
		}
		dot := center.X*ray.X + center.Y*ray.Y
		discriminant := dot*dot - lengthSquared*(center.X*center.X+center.Y*center.Y-boundaryRadius*boundaryRadius)
		if discriminant < 0 {
			continue
		}
		for _, fraction := range []float64{(-dot - math.Sqrt(discriminant)) / lengthSquared, (-dot + math.Sqrt(discriminant)) / lengthSquared} {
			if fraction < 0 {
				continue
			}
			point := center.Add(ray.Scale(fraction))
			dynamic = append(dynamic, boundaryAngle{value: math.Atan2(point.Y, point.X), sample: -1})
		}
	}
	scratch.dynamic = dynamic
	sort.Slice(dynamic, func(i, j int) bool { return dynamic[i].value < dynamic[j].value })
	angles := slices.Grow(scratch.angles[:0], len(boundarySampleAngles)+len(dynamic))
	dynamicIndex := 0
	for sample, angle := range boundarySampleAngles {
		for dynamicIndex < len(dynamic) && dynamic[dynamicIndex].value < angle {
			angles = append(angles, dynamic[dynamicIndex])
			dynamicIndex++
		}
		angles = append(angles, boundaryAngle{value: angle, sample: sample})
	}
	angles = append(angles, dynamic[dynamicIndex:]...)
	scratch.angles = angles
	pointAt := func(angle boundaryAngle) Vec2 {
		if angle.sample >= 0 {
			unit := boundarySampleUnits[angle.sample]
			return Vec2{unit.X * boundaryRadius, unit.Y * boundaryRadius}
		}
		sine, cosine := math.Sincos(angle.value)
		return Vec2{cosine * boundaryRadius, sine * boundaryRadius}
	}
	arcs := scratch.arcs[:0]
	radiusSquared := radius * radius
	endpointRadiusSquared := (radius + 1e-7) * (radius + 1e-7)
	for index := 1; index < len(angles); index++ {
		left, right := angles[index-1], angles[index]
		if right.value-left.value < 1e-10 {
			continue
		}
		midpoint, start, end := pointAt(boundaryAngle{value: (left.value + right.value) / 2, sample: -1}), pointAt(left), pointAt(right)
		if distanceSquared(center, midpoint) > radiusSquared || distanceSquared(center, start) > endpointRadiusSquared || distanceSquared(center, end) > endpointRadiusSquared || !visible(center, midpoint) {
			continue
		}
		if len(arcs) > 0 && math.Abs(arcs[len(arcs)-1].end-left.value) < 1e-10 {
			arcs[len(arcs)-1].end = right.value
		} else {
			arcs = append(arcs, visibleArc{start: left.value, end: right.value})
		}
	}
	scratch.arcs = arcs
	var edges []BoundaryEdge
	for _, arc := range arcs {
		start := pointAt(boundaryAngle{value: arc.start, sample: -1})
		for index := 1; index < boundarySampleCount; index++ {
			angle := boundarySampleAngles[index]
			if angle <= arc.start+1e-10 || angle >= arc.end-1e-10 {
				continue
			}
			end := pointAt(boundaryAngle{sample: index})
			edges = append(edges, BoundaryEdge{Kind: kind, Start: start, End: end})
			start = end
		}
		edges = append(edges, BoundaryEdge{Kind: kind, Start: start, End: pointAt(boundaryAngle{value: arc.end, sample: -1})})
	}
	return edges
}

func visibleFace(center Vec2, radius float64, start, end Vec2, corners []Vec2, visible func(Vec2, Vec2) bool) []Wall {
	direction := end.Sub(start)
	lengthSquared := direction.X*direction.X + direction.Y*direction.Y
	if lengthSquared == 0 {
		return nil
	}
	relative := start.Sub(center)
	projection := -(relative.X*direction.X + relative.Y*direction.Y) / lengthSquared
	discriminant := projection*projection - (relative.X*relative.X+relative.Y*relative.Y-radius*radius)/lengthSquared
	if discriminant <= 0 {
		return nil
	}
	lower := math.Max(0, projection-math.Sqrt(discriminant))
	upper := math.Min(1, projection+math.Sqrt(discriminant))
	if lower >= upper {
		return nil
	}
	breaks := []float64{lower, upper}
	for _, corner := range corners {
		ray := corner.Sub(center)
		cross := direction.X*ray.Y - direction.Y*ray.X
		if math.Abs(cross) < 1e-12 {
			continue
		}
		fraction := -(relative.X*ray.Y - relative.Y*ray.X) / cross
		if fraction > lower && fraction < upper {
			breaks = append(breaks, fraction)
		}
	}
	sort.Float64s(breaks)
	var faces []Wall
	for index := 1; index < len(breaks); index++ {
		left, right := breaks[index-1], breaks[index]
		if right-left < 1e-9 {
			continue
		}
		midpoint := start.Add(direction.Scale((left + right) / 2))
		outward := center.Sub(midpoint)
		probe := midpoint.Add(outward.Scale(1e-7 / outward.Len()))
		if !visible(center, probe) {
			continue
		}
		minimum, maximum := start.Add(direction.Scale(left)), start.Add(direction.Scale(right))
		if len(faces) > 0 && distanceSquared(faces[len(faces)-1].Max, minimum) < 1e-16 {
			faces[len(faces)-1].Max = maximum
		} else {
			faces = append(faces, Wall{Min: minimum, Max: maximum})
		}
	}
	return faces
}

func distanceSquared(a, b Vec2) float64 {
	dx, dy := a.X-b.X, a.Y-b.Y
	return dx*dx + dy*dy
}
