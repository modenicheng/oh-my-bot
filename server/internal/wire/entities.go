package wire

import (
	"errors"
	"math"
	"unicode/utf8"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

type entitySource interface{ GetBase() *ombv1.EntityBase }

func quantizeEntity(kind int, src entitySource, prev entity, seen bool) (uint32, entity, error) {
	var q entity
	b := src.GetBase()
	if b == nil || b.Pos == nil {
		return 0, q, errors.New("wire: missing entity/base/position")
	}
	x, err := centimetres(b.Pos.X, true)
	if err != nil {
		return 0, q, err
	}
	y, err := centimetres(b.Pos.Y, true)
	if err != nil {
		return 0, q, err
	}
	q[0] = x + y
	set := func(bit int, v string, e error) {
		if e != nil {
			err = e
		}
		q[bit] = v
	}
	set16 := func(bit int, v uint32) { value, e := checkedU16(v); set(bit, value, e) }
	setI16 := func(bit int, v int32) { value, e := checkedI16(v); set(bit, value, e) }
	setText := func(bit int, v string) {
		if seen && v == "" {
			q[bit] = prev[bit]
			return
		}
		value, e := wireString(v)
		set(bit, value, e)
	}
	switch kind {
	case robot:
		r := src.(*ombv1.RobotState)
		v, e := heading(b.Heading)
		set(1, v, e)
		setI16(2, r.HpX10)
		setI16(3, r.EnergyX10)
		q[4] = string([]byte{boolByte(r.ShieldOn) | boolByte(r.Dashing)<<1 | boolByte(r.Dead)<<2})
		set16(5, r.RespawnInS)
		q[6], q[7], q[8] = prev[6], prev[7], prev[8]
		if r.InvulnS != nil {
			set16(6, *r.InvulnS)
		}
		if r.MaxHpX10 != nil {
			setI16(7, *r.MaxHpX10)
		}
		if r.MaxEnergyX10 != nil {
			setI16(8, *r.MaxEnergyX10)
		}
		setText(9, r.Nick)
		setText(10, r.Color)
	case projectile:
		p := src.(*ombv1.ProjectileState)
		v, e := heading(b.Heading)
		set(1, v, e)
		q[2] = u32(p.OwnerId)
		setText(3, p.Color)
	case core:
		q[1] = u32(uint32(src.(*ombv1.CoreState).Value))
	case uplink:
		u := src.(*ombv1.UplinkState)
		q[1] = string([]byte{boolByte(u.Ready)})
		q[2] = u32(u.HackingId)
		setI16(3, u.ProgressX10)
		set16(4, u.MyCooldownS)
	case healthPack:
		p := src.(*ombv1.HealthPackState)
		q[1] = string([]byte{boolByte(p.Available)})
		set16(2, p.RespawnInS)
	case pointDrop:
		q[1] = u32(uint32(src.(*ombv1.PointDropState).Points))
	}
	return b.Id, q, err
}

func readEntity(r *reader, kind int, prev entity, seen, requireFirst bool) entity {
	mask := r.u16()
	sizes := fieldSizes[kind]
	if mask>>len(sizes) != 0 {
		r.err = errors.New("wire: unknown entity mask")
		return prev
	}
	if !seen && requireFirst && mask&requiredMasks[kind] != requiredMasks[kind] {
		r.err = errors.New("wire: first entity record missing required fields")
		return prev
	}
	for bit, size := range sizes {
		if mask&(1<<bit) == 0 {
			continue
		}
		start := r.off
		if size < 0 {
			n := r.u16()
			b := r.take(int(n))
			if r.err == nil && !utf8.Valid(b) {
				r.err = errors.New("wire: invalid UTF-8")
			}
		} else {
			r.take(size)
		}
		if r.err != nil {
			return prev
		}
		v := string(r.b[start:r.off])
		if (kind == uplink || kind == healthPack) && bit == 1 && v[0] > 1 {
			r.err = errors.New("wire: invalid entity boolean")
			return prev
		}
		if kind == robot && bit == 4 && v[0] & ^byte(7) != 0 {
			r.err = errors.New("wire: unknown robot flags")
			return prev
		}
		prev[bit] = v
	}
	return prev
}

func entityBase(id uint32, q entity, withHeading bool) *ombv1.EntityBase {
	b := &ombv1.EntityBase{Id: id, Pos: &ombv1.Vec2{
		X: float64(asI16(q[0][:2])) / 100,
		Y: float64(asI16(q[0][2:])) / 100,
	}}
	if withHeading {
		b.Heading = float32(float64(asU16(q[1])) * 2 * math.Pi / 65536)
	}
	return b
}

func appendEntity(s *ombv1.SnapshotDelta, kind int, id uint32, q entity) {
	b := entityBase(id, q, kind == robot || kind == projectile)
	switch kind {
	case robot:
		r := &ombv1.RobotState{Base: b, HpX10: asI16(q[2]), EnergyX10: asI16(q[3]),
			ShieldOn: q[4][0]&1 != 0, Dashing: q[4][0]&2 != 0, Dead: q[4][0]&4 != 0,
			RespawnInS: uint32(asU16(q[5])), Nick: q[9][2:], Color: q[10][2:]}
		if q[6] != "" {
			v := uint32(asU16(q[6]))
			r.InvulnS = &v
		}
		if q[7] != "" {
			v := asI16(q[7])
			r.MaxHpX10 = &v
		}
		if q[8] != "" {
			v := asI16(q[8])
			r.MaxEnergyX10 = &v
		}
		s.Robots = append(s.Robots, r)
	case projectile:
		s.Projectiles = append(s.Projectiles, &ombv1.ProjectileState{Base: b, OwnerId: asU32(q[2]), Color: q[3][2:]})
	case core:
		s.Cores = append(s.Cores, &ombv1.CoreState{Base: b, Value: int32(asU32(q[1]))})
	case uplink:
		s.Uplinks = append(s.Uplinks, &ombv1.UplinkState{Base: b, Ready: q[1][0] != 0, HackingId: asU32(q[2]), ProgressX10: asI16(q[3]), MyCooldownS: uint32(asU16(q[4]))})
	case healthPack:
		s.HealthPacks = append(s.HealthPacks, &ombv1.HealthPackState{Base: b, Available: q[1][0] != 0, RespawnInS: uint32(asU16(q[2]))})
	case pointDrop:
		s.PointDrops = append(s.PointDrops, &ombv1.PointDropState{Base: b, Points: int32(asU32(q[1]))})
	}
}

func goneSections(s *ombv1.SnapshotDelta) [entityKinds]*[]uint32 {
	return [entityKinds]*[]uint32{&s.RobotGone, &s.ProjectileGone, &s.CoreGone, &s.UplinkGone, &s.HealthPackGone, &s.PointDropGone}
}
