package wire

import (
	"errors"
	"fmt"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"google.golang.org/protobuf/proto"
)

// Decoder validates complete frames before publishing messages or state changes.
type Decoder struct{ state baseline }

func NewDecoder() *Decoder { return &Decoder{} }

// Reset invalidates the compact baseline until the next compact full snapshot.
func (d *Decoder) Reset() { d.state = baseline{} }

func (d *Decoder) DecodeFrame(b []byte) ([]*ombv1.ServerMsg, error) {
	if len(b) == 0 {
		return nil, errors.New("wire: invalid frame size")
	}
	// Keep standalone protobuf's legacy size behavior. Script history has no
	// application-level aggregate bound; only the new realtime formats impose
	// this budget. Protobuf children still fit within the capped outer batch.
	if b[0] != 3 && len(b) > MaxFrameBytes {
		return nil, errors.New("wire: invalid frame size")
	}
	// A single speculative state spans every child. No output or reset becomes
	// visible if a later child is malformed. Immutable field values permit a
	// shallow map clone, while decoded application messages own their data.
	next := d.state.clone()
	var out []*ombv1.ServerMsg
	if b[0] != FrameBatch {
		msg, err := decodeChild(b, &next)
		if err != nil {
			return nil, err
		}
		out = append(out, msg)
	} else {
		r := reader{b: b, off: 1}
		if r.u8() != 1 {
			return nil, errors.New("wire: unknown batch version")
		}
		count := r.u16()
		if count > MaxBatchChildren {
			return nil, errors.New("wire: too many batch children")
		}
		for i := uint16(0); i < count; i++ {
			n := r.u32()
			if n == 0 || n > MaxFrameBytes {
				return nil, errors.New("wire: invalid child length")
			}
			child := r.take(int(n))
			if r.err != nil {
				return nil, r.err
			}
			msg, err := decodeChild(child, &next)
			if err != nil {
				return nil, fmt.Errorf("wire: child %d: %w", i, err)
			}
			out = append(out, msg)
		}
		if err := r.done(); err != nil {
			return nil, err
		}
	}
	d.state = next
	return out, nil
}

func decodeChild(b []byte, state *baseline) (*ombv1.ServerMsg, error) {
	if len(b) == 0 {
		return nil, errTruncated
	}
	switch b[0] {
	case 3:
		msg := &ombv1.ServerMsg{}
		if err := proto.Unmarshal(b[1:], msg); err != nil {
			return nil, fmt.Errorf("wire: invalid protobuf: %w", err)
		}
		if msg.GetEvent().GetMapBootstrap() != nil || msg.GetSnapshot().GetFull() {
			*state = baseline{}
		}
		return msg, nil
	case FrameSnapshot:
		return decodeSnapshot(b, state)
	default:
		return nil, errors.New("wire: invalid frame/child type")
	}
}

func decodeSnapshot(b []byte, state *baseline) (*ombv1.ServerMsg, error) {
	r := reader{b: b, off: 1}
	if r.u8() != 1 {
		return nil, errors.New("wire: unknown snapshot version")
	}
	flags := r.u8()
	if flags & ^byte(7) != 0 {
		return nil, errors.New("wire: unknown snapshot flags")
	}
	s := &ombv1.SnapshotDelta{Full: flags&1 != 0, Tick: r.u32(), BaseTick: r.u32(), AckSeq: r.u32(),
		Phase: ombv1.Phase(r.u8()), TimeLeftS: r.u32()}
	sections := r.u16()
	if sections & ^uint16(0x0fff) != 0 {
		return nil, errors.New("wire: unknown snapshot sections")
	}
	if r.err != nil {
		return nil, r.err
	}
	gap := !s.Full && (!state.ready || s.BaseTick != state.tick)
	if s.Full {
		*state = baseline{}
	}
	gone := goneSections(s)
	for section := 0; section < 12; section++ {
		if sections&(1<<section) == 0 {
			continue
		}
		kind := section / 2
		count := int(r.u16())
		minimum := 6
		if section%2 != 0 {
			minimum = 4
		}
		if r.err != nil {
			return nil, r.err
		}
		if count > (len(b)-r.off)/minimum {
			return nil, errTruncated
		}
		for i := 0; i < count; i++ {
			id := r.u32()
			if section%2 != 0 {
				if !gap {
					*gone[kind] = append(*gone[kind], id)
					delete(state.entities[kind], id)
				}
				continue
			}
			prev, seen := state.entities[kind][id]
			q := readEntity(&r, kind, prev, seen, !gap)
			if r.err != nil {
				return nil, r.err
			}
			if !gap {
				state.put(kind, id, q)
				appendEntity(s, kind, id, q)
			}
		}
	}
	if flags&2 != 0 {
		start := r.off
		self := readSelf(&r)
		if !gap && r.err == nil {
			s.Self = self
			state.self, state.selfBytes = cloneSelf(self), string(b[start:r.off])
		}
	}
	if flags&4 != 0 {
		v := r.u16()
		if !gap && r.err == nil {
			radius := float64(v) / 100
			s.VisionRadius = &radius
			state.radius = u16(v)
		}
	}
	if err := r.done(); err != nil {
		return nil, err
	}
	if gap {
		state.ready = false
	} else {
		state.tick, state.ready = s.Tick, true
	}
	return &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Snapshot{Snapshot: s}}, nil
}
