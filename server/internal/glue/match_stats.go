package glue

import (
	"slices"
	"time"
)

// A bounded window keeps stage distributions aligned with the total tick.
const tickStatWindowLen = 600

type tickSample struct {
	total, lockWait, simulation, observation, scripts, snapshot time.Duration
}

// DurationStats uses nearest-rank p95 and includes scheduler/GC wall time.
type DurationStats struct {
	AvgMs float64 `json:"avg_ms"`
	P95Ms float64 `json:"p95_ms"`
	MaxMs float64 `json:"max_ms"`
}

type TickStages struct {
	LockWait    DurationStats `json:"lock_wait"`
	Simulation  DurationStats `json:"simulation"`
	Observation DurationStats `json:"observation"`
	Scripts     DurationStats `json:"scripts"`
	Snapshot    DurationStats `json:"snapshot"`
}

// MatchStats is the operational snapshot; existing telemetry fields stay compatible.
type MatchStats struct {
	Tick            uint32     `json:"tick"`
	TickAvgMs       float64    `json:"tick_avg_ms"`
	TickP95Ms       float64    `json:"tick_p95_ms"`
	WindowTicks     uint32     `json:"window_ticks"`
	Warmup          bool       `json:"warmup"`
	ScriptDeferrals uint64     `json:"script_deferrals"`
	Stages          TickStages `json:"stages"`
}

func (m *Match) recordTickStat(started time.Time, sample tickSample) {
	sample.total = time.Since(started)
	m.statMu.Lock()
	defer m.statMu.Unlock()
	m.statTick = m.tick
	if len(m.tickWindow) < tickStatWindowLen {
		m.tickWindow = append(m.tickWindow, sample)
		return
	}
	m.tickWindow[m.tickCursor] = sample
	m.tickCursor = (m.tickCursor + 1) % tickStatWindowLen
}

// StatSnapshot copies under the leaf lock and summarizes outside it. Publishing
// the completed tick with its sample avoids racing the authoritative tick writer.
func (m *Match) StatSnapshot() MatchStats {
	m.statMu.Lock()
	window := slices.Clone(m.tickWindow)
	tick := m.statTick
	m.statMu.Unlock()
	out := MatchStats{Tick: tick, WindowTicks: uint32(len(window)), Warmup: m.warmup, ScriptDeferrals: m.deferrals.Load()}
	values := make([]time.Duration, len(window))
	summarize := func(value func(tickSample) time.Duration) DurationStats {
		for i, sample := range window {
			values[i] = value(sample)
		}
		return durationStats(values)
	}
	total := summarize(func(s tickSample) time.Duration { return s.total })
	out.TickAvgMs, out.TickP95Ms = total.AvgMs, total.P95Ms
	out.Stages = TickStages{
		LockWait:    summarize(func(s tickSample) time.Duration { return s.lockWait }),
		Simulation:  summarize(func(s tickSample) time.Duration { return s.simulation }),
		Observation: summarize(func(s tickSample) time.Duration { return s.observation }),
		Scripts:     summarize(func(s tickSample) time.Duration { return s.scripts }),
		Snapshot:    summarize(func(s tickSample) time.Duration { return s.snapshot }),
	}
	return out
}

// durationStats may sort its private scratch slice in place.
func durationStats(values []time.Duration) DurationStats {
	if len(values) == 0 {
		return DurationStats{}
	}
	var total time.Duration
	for _, value := range values {
		total += value
	}
	slices.Sort(values)
	return DurationStats{
		AvgMs: float64(total) / float64(len(values)) / float64(time.Millisecond),
		P95Ms: float64(values[(95*len(values)+99)/100-1]) / float64(time.Millisecond),
		MaxMs: float64(values[len(values)-1]) / float64(time.Millisecond),
	}
}
