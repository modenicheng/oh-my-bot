// Package stats — replay recalculation (JSONL → Projector → Final).
package stats

import (
	"errors"
	"fmt"
	"io"
	"os"

	sim "github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// ReadReplayOptions carries the glue-injected side tables that the JSONL log
// cannot contain (identity and pairing live outside the event stream):
// Players/Nicks/Partners mirror SetPlayerMap/SetNickMap/SetPartnerMap on the
// live projector. Feeding the same tables to both paths keeps
// "replay recalculation = live projection" exact, including BEST_PARTNER.
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
			if rec.State != nil {
				p.OnCheckpoint(*rec.State)
			}
		case "event":
			if rec.Event != nil {
				p.OnEvent(rec.Tick, rec.Event)
			}
		case "input":
			// Control inputs are replay data for sim reconstruction, not
			// stats projection; consumed (skipped) for completeness.
		default:
			return nil, fmt.Errorf("stats: unknown replay record type %q", rec.Type)
		}
	}
	_ = p.Final()
	return p, nil
}
