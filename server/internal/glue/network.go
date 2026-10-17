package glue

// SetCompactSnapshots is connection-local, not room state: old and new clients
// may share a room without changing script perception or each other's protocol.
func (s *Session) SetCompactSnapshots(enabled bool) { s.compactSnapshots.Store(enabled) }

func (s *Session) CompactSnapshots() bool { return s.compactSnapshots.Load() }
