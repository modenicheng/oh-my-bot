package sim

import "math"

func (world *Sim) spawnRandomCore(index int) bool {
	core := &world.cores[index]
	band := world.mapDef.CoreRules.SpawnBands[world.mapDef.CorePads[index].Group]
	scattered := int32(1)
	if core.Value >= 25 {
		scattered = 2
	}
	limit := max(1, (len(world.robots)+3)/4)
	for _, drop := range world.pointDrops {
		if drop.Ambient && drop.GoneAt > world.tick {
			limit--
		}
	}
	scattered = min(scattered, int32(max(0, limit)))
	positions := make([]Vec2, 0, 1+scattered)
	for count := int32(0); count <= scattered; count++ {
		position, ok := world.resourcePosition(band, positions)
		if !ok {
			return false
		}
		positions = append(positions, position)
	}
	core.Pos, core.Alive = positions[0], true
	for _, position := range positions[1:] {
		world.pointDrops = append(world.pointDrops, PointDrop{ID: world.nextProjectile, Pos: position, Points: 1, GoneAt: world.tick + PointDropTTL, Ambient: true})
		world.nextProjectile++
	}
	return true
}

func (world *Sim) resourcePosition(band CoreSpawnBand, pending []Vec2) (Vec2, bool) {
	for attempt := 0; attempt < 64; attempt++ {
		radius := math.Sqrt(band.MinRadius*band.MinRadius + world.randomUnit()*(band.MaxRadius*band.MaxRadius-band.MinRadius*band.MinRadius))
		angle := world.randomUnit() * 2 * math.Pi
		position := Vec2{X: radius * math.Cos(angle), Y: radius * math.Sin(angle)}
		if world.resourcePositionFree(position, pending) {
			return position, true
		}
	}
	return Vec2{}, false
}

func (world *Sim) resourcePositionFree(position Vec2, pending []Vec2) bool {
	if !world.freePosition(position) {
		return false
	}
	for _, core := range world.cores {
		if core.Alive && position.Sub(core.Pos).Len() < 2 {
			return false
		}
	}
	for _, drop := range world.pointDrops {
		if drop.GoneAt > world.tick && position.Sub(drop.Pos).Len() < 2 {
			return false
		}
	}
	for _, other := range pending {
		if position.Sub(other).Len() < 2 {
			return false
		}
	}
	for _, robot := range world.robots {
		if robot.State == Alive && position.Sub(robot.Position).Len() <= RobotRadius+CoreRadius+0.25 {
			return false
		}
	}
	for _, uplink := range world.mapDef.Uplinks {
		if position.Sub(uplink.Pos).Len() < uplink.InteractR+RobotRadius {
			return false
		}
	}
	for _, pack := range world.healthPacks {
		if position.Sub(pack.Pos).Len() < RobotRadius+HealthPackRadius+0.5 {
			return false
		}
	}
	return true
}
