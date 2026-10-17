package sim

import "testing"

func adaptiveSpawnMap() *MapDef {
	m := &MapDef{GeneratorVer: 12, ArenaRadius: 200}
	for i := range m.Sectors {
		m.Sectors[i] = Sector{
			ID:        uint32(i),
			Center:    Vec2{X: 50, Y: 50},
			SpawnArea: Rect{Min: Vec2{X: 0, Y: 0}, Max: Vec2{X: 100, Y: 100}},
		}
	}
	return m
}

func TestAdaptiveSpawnsClusterSmallMatches(t *testing.T) {
	s := NewSim(7, []uint32{1, 2, 3, 4}, nil)
	if err := s.SetMap(adaptiveSpawnMap()); err != nil {
		t.Fatal(err)
	}
	for _, robot := range s.robots {
		if robot.Sector != 0 {
			t.Fatalf("small match robot %d assigned to sector %d, want sector 0", robot.ID, robot.Sector)
		}
	}
}

func TestAdaptiveSpawnSectorCountScalesWithParticipants(t *testing.T) {
	for _, test := range []struct {
		participants int
		want         []uint32
	}{
		{participants: 1, want: []uint32{0}},
		{participants: 8, want: []uint32{0}},
		{participants: 9, want: []uint32{0, 1}},
		{participants: 64, want: []uint32{0, 1, 2, 3, 4, 5, 6, 7}},
		{participants: 200, want: []uint32{0, 1, 2, 3, 4, 5, 6, 7}},
	} {
		for index, want := range test.want {
			if got := adaptiveSpawnSector(test.participants, index); got != want {
				t.Fatalf("participants=%d index=%d sector=%d, want %d", test.participants, index, got, want)
			}
		}
	}
}

func TestAdaptiveSpawnPrefersDistanceFromAliveRobots(t *testing.T) {
	s := &Sim{
		simulationVersion: SimulationVersion,
		mapDef:            adaptiveSpawnMap(),
		rng:               1,
		robots: []Robot{{
			ID:       1,
			State:    Alive,
			Position: Vec2{X: 50, Y: 50},
		}},
	}

	position, ok := s.spawnInSector(0)
	if !ok {
		t.Fatal("spawn selection failed")
	}
	if distance := position.Sub(s.robots[0].Position).Len(); distance < 60 {
		t.Fatalf("spawn selected too close to alive robot: %.3fm", distance)
	}
}

func TestAdaptiveRespawnPrefersDistanceFromAliveRobots(t *testing.T) {
	s := NewSim(7, []uint32{1, 2}, nil)
	if err := s.SetMap(adaptiveSpawnMap()); err != nil {
		t.Fatal(err)
	}
	s.robots[0].Position = Vec2{X: 50, Y: 50}
	s.robots[1].State = Dead
	s.robots[1].Sector = 0

	s.respawnRobot(&s.robots[1])
	if distance := s.robots[1].Position.Sub(s.robots[0].Position).Len(); distance < 60 {
		t.Fatalf("respawn selected too close to alive robot: %.3fm", distance)
	}
}
