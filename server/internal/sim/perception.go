package sim

import (
	"math"
	"sort"
)

func (world WorldView) localMap(center Vec2, radius float64, visible func(Vec2, Vec2) bool) *MapDef {
	local := &MapDef{Version: 1, Partial: true}
	source := world.Frame.Map
	if source == nil {
		return local
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
	var corners []Vec2
	for _, wall := range source.Walls {
		corners = append(corners, wall.Min, wall.Max, Vec2{wall.Min.X, wall.Max.Y}, Vec2{wall.Max.X, wall.Min.Y})
	}
	zone := source.CoreZone
	if zone.Radius > 0 && world.Frame.Phase < zone.UnlockPhase && center.Len() > zone.Radius {
		angle := math.Atan2(center.Y, center.X)
		offset := math.Acos(zone.Radius / center.Len())
		for _, direction := range []float64{angle - offset, angle + offset} {
			corners = append(corners, Vec2{math.Cos(direction) * zone.Radius, math.Sin(direction) * zone.Radius})
		}
	}
	for _, wall := range source.Walls {
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
		local.Boundaries = append(local.Boundaries, world.visibleBoundary(center, radius, arenaRadius, "arena", corners)...)
	}
	if zone.Radius > 0 && world.Frame.Phase < zone.UnlockPhase {
		local.Boundaries = append(local.Boundaries, world.visibleBoundary(center, radius, zone.Radius, "lock", corners)...)
	}
	return local
}

func (world WorldView) visibleBoundary(center Vec2, radius, boundaryRadius float64, kind string, corners []Vec2) []BoundaryEdge {
	if math.Abs(center.Len()-boundaryRadius) >= radius {
		return nil
	}
	angles := make([]float64, 0, 514+len(corners)*2)
	for index := 0; index <= 512; index++ {
		angles = append(angles, -math.Pi+2*math.Pi*float64(index)/512)
	}
	if distance := center.Len(); distance > 0 {
		cosine := (distance*distance + boundaryRadius*boundaryRadius - radius*radius) / (2 * distance * boundaryRadius)
		if cosine > -1 && cosine < 1 {
			base, offset := math.Atan2(center.Y, center.X), math.Acos(cosine)
			for _, angle := range []float64{base - offset, base + offset} {
				angles = append(angles, math.Atan2(math.Sin(angle), math.Cos(angle)))
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
			angles = append(angles, math.Atan2(point.Y, point.X))
		}
	}
	sort.Float64s(angles)
	pointAt := func(angle float64) Vec2 {
		return Vec2{math.Cos(angle) * boundaryRadius, math.Sin(angle) * boundaryRadius}
	}
	type visibleArc struct{ start, end float64 }
	var arcs []visibleArc
	for index := 1; index < len(angles); index++ {
		left, right := angles[index-1], angles[index]
		if right-left < 1e-10 {
			continue
		}
		midpoint, start, end := pointAt((left+right)/2), pointAt(left), pointAt(right)
		if center.Sub(midpoint).Len() > radius || center.Sub(start).Len() > radius+1e-7 || center.Sub(end).Len() > radius+1e-7 || !world.SurfaceVisible(center, midpoint) {
			continue
		}
		if len(arcs) > 0 && math.Abs(arcs[len(arcs)-1].end-left) < 1e-10 {
			arcs[len(arcs)-1].end = right
		} else {
			arcs = append(arcs, visibleArc{start: left, end: right})
		}
	}
	var edges []BoundaryEdge
	for _, arc := range arcs {
		start := pointAt(arc.start)
		for index := 1; index < 512; index++ {
			angle := -math.Pi + 2*math.Pi*float64(index)/512
			if angle <= arc.start+1e-10 || angle >= arc.end-1e-10 {
				continue
			}
			end := pointAt(angle)
			edges = append(edges, BoundaryEdge{Kind: kind, Start: start, End: end})
			start = end
		}
		edges = append(edges, BoundaryEdge{Kind: kind, Start: start, End: pointAt(arc.end)})
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
		if len(faces) > 0 && faces[len(faces)-1].Max.Sub(minimum).Len() < 1e-8 {
			faces[len(faces)-1].Max = maximum
		} else {
			faces = append(faces, Wall{Min: minimum, Max: maximum})
		}
	}
	return faces
}
