package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// Encoder holds one connection's writer-order, quantized snapshot baseline.
type Encoder struct{ state baseline }

func NewEncoder() *Encoder { return &Encoder{} }

// Reset discards all connection-local state, for example at MapBootstrap.
func (e *Encoder) Reset() { e.state = baseline{} }

func snapshotHeader(s *ombv1.SnapshotDelta) ([]byte, error) {
	if s == nil {
		return nil, errors.New("wire: nil snapshot")
	}
	phase, err := checkedU8(int64(s.Phase))
	if err != nil {
		return nil, err
	}
	b := make([]byte, 0, 22)
	b = append(b, FrameSnapshot, 1, boolByte(s.Full))
	b = binary.LittleEndian.AppendUint32(b, s.Tick)
	b = binary.LittleEndian.AppendUint32(b, s.BaseTick)
	b = binary.LittleEndian.AppendUint32(b, s.AckSeq)
	b = append(b, phase...)
	b = binary.LittleEndian.AppendUint32(b, s.TimeLeftS)
	return binary.LittleEndian.AppendUint16(b, 0), nil
}

// EncodeSnapshot must run at the writer boundary, never at enqueue time. The
// returned frame owns its bytes; neither it nor the source aliases the baseline.
func (e *Encoder) EncodeSnapshot(s *ombv1.SnapshotDelta) ([]byte, error) {
	b, err := snapshotHeader(s)
	if err != nil {
		return nil, err
	}
	if !s.Full && (!e.state.ready || s.BaseTick != e.state.tick) {
		// The producer's logical delta can cross a lossy queue drop. Do not invent
		// a new baseline or close the connection: the consumer needs this header
		// to run its ordinary resync flow. Only a full can heal the stream.
		e.state.ready = false
		return b, nil
	}
	next := e.state.clone()
	if s.Full {
		next = baseline{}
	}
	var sections uint16
	counts := [entityKinds]int{len(s.Robots), len(s.Projectiles), len(s.Cores), len(s.Uplinks), len(s.HealthPacks), len(s.PointDrops)}
	gone := goneSections(s)
	for kind, count := range counts {
		if count > math.MaxUint16 || len(*gone[kind]) > math.MaxUint16 {
			return nil, errors.New("wire: entity/gone count exceeds u16")
		}
		start := len(b)
		b = binary.LittleEndian.AppendUint16(b, 0)
		var emitted uint16
		for i := 0; i < count; i++ {
			var src entitySource
			switch kind {
			case robot:
				src = s.Robots[i]
			case projectile:
				src = s.Projectiles[i]
			case core:
				src = s.Cores[i]
			case uplink:
				src = s.Uplinks[i]
			case healthPack:
				src = s.HealthPacks[i]
			case pointDrop:
				src = s.PointDrops[i]
			}
			id := src.GetBase().GetId()
			prev, seen := next.entities[kind][id]
			_, q, err := quantizeEntity(kind, src, prev, seen)
			if err != nil {
				return nil, fmt.Errorf("wire: entity kind %d id %d: %w", kind, id, err)
			}
			var mask uint16
			for bit := range fieldSizes[kind] {
				if q[bit] != "" && (!seen || q[bit] != prev[bit]) {
					mask |= 1 << bit
				}
			}
			next.put(kind, id, q)
			if mask == 0 {
				continue
			}
			b = binary.LittleEndian.AppendUint32(b, id)
			b = binary.LittleEndian.AppendUint16(b, mask)
			for bit := range fieldSizes[kind] {
				if mask&(1<<bit) != 0 {
					b = append(b, q[bit]...)
				}
			}
			emitted++
			if len(b) > MaxFrameBytes {
				return nil, errors.New("wire: frame exceeds maximum size")
			}
		}
		if emitted == 0 {
			b = b[:start]
		} else {
			sections |= 1 << (kind * 2)
			binary.LittleEndian.PutUint16(b[start:], emitted)
		}
		if ids := *gone[kind]; len(ids) != 0 {
			sections |= 1 << (kind*2 + 1)
			b = binary.LittleEndian.AppendUint16(b, uint16(len(ids)))
			for _, id := range ids {
				b = binary.LittleEndian.AppendUint32(b, id)
				delete(next.entities[kind], id)
			}
		}
	}
	binary.LittleEndian.PutUint16(b[20:], sections)
	if s.Self != nil {
		self := mergeSelf(s.Self, next.self)
		value, err := encodeSelf(self)
		if err != nil {
			return nil, err
		}
		if value != next.selfBytes {
			b[2] |= 2
			b = append(b, value...)
		}
		next.self, next.selfBytes = self, value
	}
	if s.VisionRadius != nil {
		value, err := centimetres(*s.VisionRadius, false)
		if err != nil {
			return nil, err
		}
		if value != next.radius {
			b[2] |= 4
			b = append(b, value...)
		}
		next.radius = value
	}
	if len(b) > MaxFrameBytes {
		return nil, errors.New("wire: frame exceeds maximum size")
	}
	next.tick, next.ready = s.Tick, true
	e.state = next
	return b, nil
}
