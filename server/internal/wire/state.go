package wire

import (
	"maps"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

const (
	robot = iota
	projectile
	core
	uplink
	healthPack
	pointDrop
	entityKinds
)

// Fields contain immutable, already-quantized wire bytes. Empty means unknown,
// whereas an explicitly present zero always has a nonempty wire representation.
type entity [11]string

var fieldSizes = [entityKinds][]int{
	{4, 2, 2, 2, 1, 2, 2, 2, 2, -1, -1},
	{4, 2, 4, -1},
	{4, 4},
	{4, 1, 4, 2, 2},
	{4, 1, 2},
	{4, 4},
}

var requiredMasks = [entityKinds]uint16{0x063f, 0x000f, 0x0003, 0x001f, 0x0007, 0x0003}

type baseline struct {
	entities  [entityKinds]map[uint32]entity
	self      *ombv1.SelfState
	selfBytes string
	radius    string
	tick      uint32
	ready     bool
}

func (s baseline) clone() baseline {
	for kind := range s.entities {
		s.entities[kind] = maps.Clone(s.entities[kind])
	}
	return s
}

func (s *baseline) put(kind int, id uint32, value entity) {
	if s.entities[kind] == nil {
		s.entities[kind] = make(map[uint32]entity)
	}
	s.entities[kind][id] = value
}
