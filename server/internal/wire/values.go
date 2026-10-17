package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"
)

var errTruncated = errors.New("wire: truncated frame")

type reader struct {
	b   []byte
	off int
	err error
}

func (r *reader) take(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || n > len(r.b)-r.off {
		r.err = errTruncated
		return nil
	}
	b := r.b[r.off : r.off+n]
	r.off += n
	return b
}

func (r *reader) u8() byte {
	b := r.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (r *reader) u16() uint16 {
	b := r.take(2)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint16(b)
}

func (r *reader) u32() uint32 {
	b := r.take(4)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint32(b)
}

func (r *reader) boolean() bool {
	b := r.u8()
	if b > 1 {
		r.err = errors.New("wire: invalid boolean")
	}
	return b == 1
}

func (r *reader) done() error {
	if r.err != nil {
		return r.err
	}
	if r.off != len(r.b) {
		return errors.New("wire: trailing bytes")
	}
	return nil
}

func u16(v uint16) string { return string(binary.LittleEndian.AppendUint16(nil, v)) }
func u32(v uint32) string { return string(binary.LittleEndian.AppendUint32(nil, v)) }

func checkedU8(v int64) (string, error) {
	if v < 0 || v > math.MaxUint8 {
		return "", errors.New("wire: u8 overflow")
	}
	return string([]byte{byte(v)}), nil
}

func checkedU16(v uint32) (string, error) {
	if v > math.MaxUint16 {
		return "", errors.New("wire: u16 overflow")
	}
	return u16(uint16(v)), nil
}

func checkedI16(v int32) (string, error) {
	if v < math.MinInt16 || v > math.MaxInt16 {
		return "", errors.New("wire: i16 overflow")
	}
	return u16(uint16(int16(v))), nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func centimetres(v float64, signed bool) (string, error) {
	q := math.Round(v * 100)
	lo, hi := float64(0), float64(math.MaxUint16)
	if signed {
		lo, hi = math.MinInt16, math.MaxInt16
	}
	if !finite(v) || !finite(q) || q < lo || q > hi || (!signed && v < 0) {
		return "", fmt.Errorf("wire: coordinate/radius out of range: %v", v)
	}
	return u16(uint16(int64(q))), nil
}

func heading(v float32) (string, error) {
	if !finite(float64(v)) {
		return "", errors.New("wire: non-finite heading")
	}
	turn := math.Mod(float64(v), 2*math.Pi)
	if turn < 0 {
		turn += 2 * math.Pi
	}
	q := uint32(math.Round(turn * 65536 / (2 * math.Pi)))
	return u16(uint16(q)), nil
}

func wireString(v string) (string, error) {
	if len(v) > math.MaxUint16 || !utf8.ValidString(v) {
		return "", errors.New("wire: invalid UTF-8 string or length")
	}
	return u16(uint16(len(v))) + v, nil
}

func asU16(v string) uint16 { return binary.LittleEndian.Uint16([]byte(v)) }
func asU32(v string) uint32 { return binary.LittleEndian.Uint32([]byte(v)) }
func asI16(v string) int32  { return int32(int16(asU16(v))) }

func boolByte(v bool) byte {
	if v {
		return 1
	}
	return 0
}
