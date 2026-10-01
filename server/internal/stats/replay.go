// Package stats — replay recalculation (JSONL → Projector → Final).
package stats

import (
	"errors"
	"fmt"
	"io"
	"os"

	sim "github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ReadReplayOptions supplies identity for legacy logs without a players table.
// For new logs, the embedded match_start table takes precedence. These maps
// mirror the live projector's SetPlayerMap/SetNickMap/SetPartnerMap.
type ReadReplayOptions struct {
	Players  map[uint32]uint64
	Nicks    map[uint32]string
	Partners map[uint32]uint32
}

// ReadReplay replays a JSONL match log (sim.MatchEventLog format: header +
// match_start/event/input/checkpoint lines) into a fresh ProjectorImpl and
// returns it after Final(). The caller can then compare Final()/Live() against
// the live projector fed during the match. Errors (missing file, malformed
// stream) abort with no partial projector.
func ReadReplay(path string, opts ReadReplayOptions) (*ProjectorImpl, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("stats: open replay: %w", err)
	}
	defer f.Close() // read-only handle; close error is irrelevant
	return ReadReplayFrom(f, opts)
}

// ReadReplayFrom is ReadReplay over an open stream (tests, network sources).
func ReadReplayFrom(f *os.File, opts ReadReplayOptions) (*ProjectorImpl, error) {
	reader, err := sim.NewMatchEventLogReader(f)
	if err != nil {
		return nil, fmt.Errorf("stats: replay header: %w", err)
	}
	p := NewProjector()
	if opts.Players != nil {
		p.SetPlayerMap(opts.Players)
	}
	if opts.Nicks != nil {
		p.SetNickMap(opts.Nicks)
	}
	if opts.Partners != nil {
		p.SetPartnerMap(opts.Partners)
	}
	// Sequence numbers mirror glue's live assignment (one per projected event
	// in stream order); each JSONL event line is a distinct event, never
	// content-merged, so replay == live even for identical-payload same-tick
	// events.
	seq := uint64(0)
	for {
		rec, err := reader.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break // clean stream end
			}
			return nil, fmt.Errorf("stats: replay record: %w", err)
		}
		switch rec.Type {
		case "match_start", "checkpoint":
			if rec.Type == "match_start" && len(rec.Players) != 0 {
				players := make(map[uint32]uint64, len(rec.Players))
				nicks := make(map[uint32]string, len(rec.Players))
				partners := make(map[uint32]uint32, len(rec.Players))
				for _, identity := range rec.Players {
					players[identity.RobotID] = identity.PlayerID
					nicks[identity.RobotID] = identity.Nick
					if identity.Partner != 0 {
						partners[identity.RobotID] = identity.Partner
					}
				}
				p.SetPlayerMap(players)
				p.SetNickMap(nicks)
				p.SetPartnerMap(partners)
			}
			if rec.State != nil {
				p.OnCheckpoint(*rec.State)
			}
		case "event":
			if rec.Event != nil {
				seq++
				p.OnEventRecord(seq, rec.Tick, rec.Event)
			}
		case "input", "control":
			// Inputs and controls drive deterministic sim replay, not stats
			// projection; consume both for complete log compatibility.
		default:
			return nil, fmt.Errorf("stats: unknown replay record type %q", rec.Type)
		}
	}
	_ = p.Final()
	return p, nil
}
