package wire

import (
	"encoding/binary"
	"errors"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"google.golang.org/protobuf/proto"
)

func cloneSelf(s *ombv1.SelfState) *ombv1.SelfState {
	if s == nil {
		return nil
	}
	return proto.Clone(s).(*ombv1.SelfState)
}

// Upstream optional self fields can be sparse; absence does not erase the latest
// generation (or other previously known optional state). A full starts fresh.
func mergeSelf(s, prev *ombv1.SelfState) *ombv1.SelfState {
	n := cloneSelf(s)
	if prev == nil {
		return n
	}
	if n.AssistOn == nil {
		n.AssistOn = prev.AssistOn
	}
	if n.DashReadyTick == nil {
		n.DashReadyTick = prev.DashReadyTick
	}
	if n.FireReadyTick == nil {
		n.FireReadyTick = prev.FireReadyTick
	}
	if n.FireSrc == nil {
		n.FireSrc = prev.FireSrc
	}
	if n.AbilitySrc == nil {
		n.AbilitySrc = prev.AbilitySrc
	}
	if n.ManualAxesMask == nil {
		n.ManualAxesMask = prev.ManualAxesMask
	}
	if n.Upgrade == nil {
		n.Upgrade = prev.Upgrade
	}
	if n.ShieldReadyTick == nil {
		n.ShieldReadyTick = prev.ShieldReadyTick
	}
	if n.ShieldStartedTick == nil {
		n.ShieldStartedTick = prev.ShieldStartedTick
	}
	if n.InputGeneration == nil {
		n.InputGeneration = prev.InputGeneration
	}
	return n
}

func encodeSelf(s *ombv1.SelfState) (string, error) {
	b := make([]byte, 2, 64)
	var mask uint16
	var err error
	u8 := func(v int64) {
		value, e := checkedU8(v)
		if e != nil {
			err = e
		}
		b = append(b, value...)
	}
	optional := func(bit uint, v *uint32) {
		if v != nil {
			mask |= 1 << bit
			b = binary.LittleEndian.AppendUint32(b, *v)
		}
	}
	b = binary.LittleEndian.AppendUint32(b, s.RobotId)
	u8(int64(s.MoveSrc))
	u8(int64(s.TurretSrc))
	b = binary.LittleEndian.AppendUint32(b, s.AiRoundsLeft)
	b = binary.LittleEndian.AppendUint32(b, s.AiTokensLeftK)
	if s.AssistOn != nil {
		mask |= 1
		b = append(b, boolByte(*s.AssistOn))
	}
	optional(1, s.DashReadyTick)
	optional(2, s.FireReadyTick)
	if s.FireSrc != nil {
		mask |= 1 << 3
		u8(int64(*s.FireSrc))
	}
	if s.AbilitySrc != nil {
		mask |= 1 << 4
		u8(int64(*s.AbilitySrc))
	}
	optional(5, s.ManualAxesMask)
	if s.Upgrade != nil {
		mask |= 1 << 6
		if len(s.Upgrade.Levels) > 5 {
			return "", errors.New("wire: upgrade count exceeds five")
		}
		b = binary.LittleEndian.AppendUint32(b, s.Upgrade.Points)
		b = append(b, byte(len(s.Upgrade.Levels)))
		for _, level := range s.Upgrade.Levels {
			if level > 10 {
				return "", errors.New("wire: upgrade level exceeds ten")
			}
			b = append(b, byte(level))
		}
	}
	optional(7, s.ShieldReadyTick)
	optional(8, s.ShieldStartedTick)
	optional(9, s.InputGeneration)
	binary.LittleEndian.PutUint16(b, mask)
	return string(b), err
}

func readSelf(r *reader) *ombv1.SelfState {
	mask := r.u16()
	if mask & ^uint16(0x03ff) != 0 {
		r.err = errors.New("wire: unknown self presence bits")
		return nil
	}
	s := &ombv1.SelfState{RobotId: r.u32(), MoveSrc: ombv1.ControlSource(r.u8()),
		TurretSrc: ombv1.ControlSource(r.u8()), AiRoundsLeft: r.u32(), AiTokensLeftK: r.u32()}
	optional := func(bit uint) *uint32 {
		if mask&(1<<bit) == 0 {
			return nil
		}
		v := r.u32()
		return &v
	}
	if mask&1 != 0 {
		v := r.boolean()
		s.AssistOn = &v
	}
	s.DashReadyTick = optional(1)
	s.FireReadyTick = optional(2)
	if mask&(1<<3) != 0 {
		v := ombv1.ControlSource(r.u8())
		s.FireSrc = &v
	}
	if mask&(1<<4) != 0 {
		v := ombv1.ControlSource(r.u8())
		s.AbilitySrc = &v
	}
	s.ManualAxesMask = optional(5)
	if mask&(1<<6) != 0 {
		s.Upgrade = &ombv1.UpgradeSelf{Points: r.u32()}
		count := r.u8()
		if count > 5 {
			r.err = errors.New("wire: upgrade count exceeds five")
			return nil
		}
		for i := byte(0); i < count; i++ {
			level := r.u8()
			if level > 10 {
				r.err = errors.New("wire: upgrade level exceeds ten")
				return nil
			}
			s.Upgrade.Levels = append(s.Upgrade.Levels, uint32(level))
		}
	}
	s.ShieldReadyTick = optional(7)
	s.ShieldStartedTick = optional(8)
	s.InputGeneration = optional(9)
	return s
}
