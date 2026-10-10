package room

import (
	"crypto/rand"
	"math/big"
)

// codeAlphabet excludes easily confused characters (0/O, 1/I) per the
// room-code requirement.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// codeLen is the fixed room code length.
const codeLen = 6

// maxJoinCodeLen bounds join-side room codes. It mirrors the join form cap
// (client lobby slices input to 8 characters); the server applies the same
// bound to direct-WebSocket joiners (audit S-31).
const maxJoinCodeLen = 8

// codeCharSet is derived from codeAlphabet (single source, no second copy).
var codeCharSet = func() (set [256]bool) {
	for i := 0; i < len(codeAlphabet); i++ {
		set[codeAlphabet[i]] = true
	}
	return set
}()

// ValidCode reports whether code is acceptable as a join room code: non-empty,
// at most maxJoinCodeLen bytes, and drawn entirely from codeAlphabet (the same
// alphabet GenerateCode samples from — audit S-31: no parallel alphabet).
// Uppercase-only by construction; lowercase input is rejected.
func ValidCode(code string) bool {
	if len(code) == 0 || len(code) > maxJoinCodeLen {
		return false
	}
	for i := 0; i < len(code); i++ {
		if !codeCharSet[code[i]] {
			return false
		}
	}
	return true
}

// GenerateCode returns a new 6-character room code drawn uniformly from
// codeAlphabet using crypto/rand. It panics only if the system CSPRNG is
// broken, which is unrecoverable.
func GenerateCode() string {
	max := big.NewInt(int64(len(codeAlphabet)))
	out := make([]byte, codeLen)
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			// crypto/rand failure means the host entropy source is broken;
			// there is no safe fallback for a room invitation code.
			panic("room: crypto/rand unavailable: " + err.Error())
		}
		out[i] = codeAlphabet[n.Int64()]
	}
	return string(out)
}
