// Package wire implements the connection-local omb.binary.v1 snapshot codec.
// Encoders and decoders are ordered stream state and are not concurrency-safe.
package wire

const (
	Subprotocol           = "omb.binary.v1"
	FrameSnapshot    byte = 4
	FrameBatch       byte = 5
	MaxFrameBytes         = 65536
	MaxBatchChildren      = 64
)
