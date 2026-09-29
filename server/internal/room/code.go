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
