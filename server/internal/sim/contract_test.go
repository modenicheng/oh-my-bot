package sim

import (
	"errors"
	"math"
	"testing"
)

// TestX10ConversionHelpers freezes the exact x10 fixed-point semantics that
// every wire conversion site must share (S-16): round-half-away-from-zero on
// encode, exact decimal on decode.
func TestX10ConversionHelpers(t *testing.T) {
	cases := []struct {
		in   float64
		want int32
	}{
		{0, 0},
		{100, 1000},
		{12.5, 125},
		{12.34, 123},   // 123.4 truncation would also give 123
		{12.35, 124},   // 123.5 rounds up; truncation would give 123
		{-0.05, -1},    // -0.5 rounds away from zero; truncation would give 0
		{-12.35, -124}, // symmetric negative rounding
		{0.04, 0},
	}
	for _, c := range cases {
		if got := ToX10(c.in); got != c.want {
			t.Errorf("ToX10(%v) = %d, want %d", c.in, got, c.want)
		}
		if back := FromX10(c.want); math.Abs(back-c.in) > 0.05+1e-9 { // half of the 0.1 grid spacing
			t.Errorf("FromX10(ToX10(%v)) = %v, want within 0.05", c.in, back)
		}
	}
	if got := FromX10(123); got != 12.3 {
		t.Errorf("FromX10(123) = %v, want 12.3", got)
	}
	if got := FromX10(-7); got != -0.7 {
		t.Errorf("FromX10(-7) = %v, want -0.7", got)
	}
}

// TestAssemblySentinels pins the sentinel identity and the unchanged wire
// message text, so existing callers keyed on the string keep working while
// errors.Is becomes available (S-18).
func TestAssemblySentinels(t *testing.T) {
	s := NewSim(1, []uint32{1}, nil)
	if err := s.SetMap(nil); !errors.Is(err, ErrMapRequired) {
		t.Fatalf("SetMap(nil) = %v, want ErrMapRequired", err)
	}
	if err := ErrMapRequired; err.Error() != "sim: map required before match start" {
		t.Fatalf("ErrMapRequired text changed: %q", err.Error())
	}
	if err := ErrIdentityFrozen; err.Error() != "sim: identity already set or match started" {
		t.Fatalf("ErrIdentityFrozen text changed: %q", err.Error())
	}
}
