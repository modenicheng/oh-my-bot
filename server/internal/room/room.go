// Package room implements the per-room lifecycle state machine
// (Idle → Warmup → Running → Ended, Restart back to Warmup) described in
// game_design_v0.3 §2: a Room is the only entry to a match, seats 1–64
// players, and a Session keeps cumulative scores across matches while the
// room itself persists ("局散房不散").
//
// All exported methods are safe for concurrent use: the WebSocket layer may
// call Join/Leave/HostCommand/AddMatchResult/StateBroadcast from many
// connections at once, so a single mutex guards every mutable field.
package room

import (
	"cmp"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"sync"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// State is the room lifecycle state. It mirrors ombv1.EvRoomState_State
// (R_IDLE/R_WARMUP/R_RUNNING/R_ENDED) but is its own type so the state
// machine does not depend on wire enum values staying stable.
type State int

const (
	Idle State = iota
	Warmup
	Running
	Ended
)

// String implements fmt.Stringer for test failures and logs.
func (s State) String() string {
	switch s {
	case Idle:
		return "Idle"
	case Warmup:
		return "Warmup"
	case Running:
		return "Running"
	case Ended:
		return "Ended"
	default:
		return fmt.Sprintf("State(%d)", int(s))
	}
}

// protoState maps the internal State to the wire enum.
func (s State) protoState() ombv1.EvRoomState_State {
	switch s {
	case Warmup:
		return ombv1.EvRoomState_R_WARMUP
	case Running:
		return ombv1.EvRoomState_R_RUNNING
	case Ended:
		return ombv1.EvRoomState_R_ENDED
	default:
		return ombv1.EvRoomState_R_IDLE
	}
}

// Action is a host-issued room command, mirroring ombv1.RoomAction_Kind.
type Action int

const (
	ActionStart    Action = iota + 1 // START:  begin a scored match
	ActionAbort                      // ABORT:  end a running match early
	ActionRestart                    // RESTART: after a match ends, go again
	ActionWarmup                     // WARMUP: enter the warmup lobby
	ActionSoloBots                   // SOLO_BOTS: toggle deterministic test opponents
)

// String implements fmt.Stringer.
func (a Action) String() string {
	switch a {
	case ActionStart:
		return "Start"
	case ActionAbort:
		return "Abort"
	case ActionRestart:
		return "Restart"
	case ActionWarmup:
		return "Warmup"
	case ActionSoloBots:
		return "SoloBots"
	default:
		return fmt.Sprintf("Action(%d)", int(a))
	}
}

// MaxPlayers is the hard seat limit per game_design_v0.3 §2 (1–64 robots).
const MaxPlayers = 64

// MaxSoloBots fills every non-human seat while always reserving at least one
// seat for the room host. Launch assembly still caps the final roster at
// MaxPlayers when more humans are seated.
const MaxSoloBots = MaxPlayers - 1

// MatchHandle is the running-side handle of a launched match. The room only
// ever needs to abort it; lifecycle completion is driven externally by the
// caller reporting AddMatchResult and moving the room to Ended.
type MatchHandle interface {
	Abort()
}

// SimLauncher is how the room starts the authoritative simulation without
// importing the (parallel-developed) sim package. The implementation is
// expected to spawn a match with the given seed and players.
type SimLauncher interface {
	Launch(seed uint64, playerIDs []uint64) MatchHandle
	// LaunchWarmup 装配热身场（同链路、warmup 语义：不落日志、无结算）。
	LaunchWarmup(seed uint64, playerIDs []uint64) MatchHandle
}

// SoloBotLauncher is an optional extension used by the real glue launcher.
// Rooms keep synthetic bots out of membership and transport identity maps.
type SoloBotLauncher interface {
	LaunchWithBots(seed uint64, playerIDs []uint64, botCount uint32) MatchHandle
	LaunchWarmupWithBots(seed uint64, playerIDs []uint64, botCount uint32) MatchHandle
}

// Member is a seated player.
type Member struct {
	PlayerID uint64
	Nick     string
	Color    string
}

// Room is one private room (ADR-0008). Create with NewRoom.
type Room struct {
	mu   sync.Mutex
	code string
	host uint64 // host player id

	state State

	members map[uint64]*Member
	// joinOrder keeps the player list ordered for seed/passing to Launch.
	joinOrder []uint64

	session map[uint64]int32 // cumulative Session scores
	seed    uint64           // map seed of the current/last match

	launcher   SimLauncher // may be nil (tests / warmup-only rooms)
	match      MatchHandle // non-nil while a match is running
	lastMatch  MatchHandle // handle kept after match end; Abort must be idempotent
	aborted    bool        // true if last match was aborted by host
	sessionSeq int         // number of matches started

	pendingNicks map[uint64]string
	soloBots     uint32
}

// NewRoom creates a room with the given code and host. The host is not
// automatically a member; call Join for that (the WS layer will, right
// after creating the room).
func NewRoom(code string, hostPlayerID uint64) *Room {
	return &Room{
		code:    code,
		host:    hostPlayerID,
		state:   Idle,
		members: make(map[uint64]*Member),
		session: make(map[uint64]int32),
	}
}

// SetSimLauncher wires the launcher used on START. Optional; a room without
// a launcher can still transition states (useful in tests and for warmup).
func (r *Room) SetSimLauncher(l SimLauncher) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.launcher = l
}

// Code returns the room code.
func (r *Room) Code() string {
	return r.code
}

// State returns the current lifecycle state.
func (r *Room) State() State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

// HostID returns the host's player id.
// SetPendingNick 记录昵称（Join 前的 StateBroadcast 兜底用）。
func (r *Room) SetPendingNick(playerID uint64, nick string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingNicks == nil {
		r.pendingNicks = map[uint64]string{}
	}
	r.pendingNicks[playerID] = nick
}

// TransferHost 将房主移交给指定成员（仅允许从占位 0 移交——glue 首进接管）。
func (r *Room) TransferHost(playerID uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.host != 0 {
		return
	}
	r.host = playerID
}

func (r *Room) HostID() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.host
}

// IsHost reports whether playerID is the host.
func (r *Room) IsHost(playerID uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return playerID == r.host
}

// SoloBots returns the number of deterministic test opponents configured for
// the next launch. They are not room members and do not affect online count.
func (r *Room) SoloBots() uint32 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.soloBots
}

// SetSoloBots configures the next launch without requiring a host command. It
// is used only for explicit server defaults (for example a local stress room).
func (r *Room) SetSoloBots(count uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if count > MaxSoloBots {
		count = MaxSoloBots
	}
	r.soloBots = count
}

// MemberCount returns the number of seated players.
func (r *Room) MemberCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.members)
}

// ErrRoomFull, ErrAlreadyJoined, ErrNotMember and ErrNotHost are membership
// errors returned by Join/Leave/HostCommand.
var (
	ErrRoomFull       = errors.New("room: room is full (64 players)")
	ErrAlreadyJoined  = errors.New("room: player already in room")
	ErrNotMember      = errors.New("room: player not in room")
	ErrNotHost        = errors.New("room: only the host may issue room commands")
	ErrNoPlayers      = errors.New("room: cannot start a match with no players")
	ErrIllegalTransit = errors.New("room: illegal state transition")
	ErrNoLauncher     = errors.New("room: no SimLauncher configured")
	ErrNoSoloBots     = errors.New("room: launcher does not support solo bots")
)

// Join seats a player. It fails if the room is full, or the player is
// already seated. It succeeds in any room state: players may join mid-
// warmup or even mid-match (late join is a transport concern; the room
// just tracks membership).
func (r *Room) Join(playerID uint64, nick, color string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.members[playerID]; ok {
		return ErrAlreadyJoined
	}
	if len(r.members) >= MaxPlayers {
		return ErrRoomFull
	}
	r.members[playerID] = &Member{PlayerID: playerID, Nick: nick, Color: color}
	r.joinOrder = append(r.joinOrder, playerID)
	// Ensure the player exists on the session board even before scoring.
	if _, ok := r.session[playerID]; !ok {
		r.session[playerID] = 0
	}
	return nil
}

// Leave explicitly releases a seat. Transport disconnects must not call Leave.
// When the host explicitly leaves, the next seated player inherits host rights.
func (r *Room) Leave(playerID uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.members[playerID]; !ok {
		return ErrNotMember
	}
	delete(r.members, playerID)
	delete(r.pendingNicks, playerID)
	for i, id := range r.joinOrder {
		if id == playerID {
			r.joinOrder = append(r.joinOrder[:i], r.joinOrder[i+1:]...)
			break
		}
	}
	if r.host == playerID {
		r.host = 0
		if len(r.joinOrder) > 0 {
			r.host = r.joinOrder[0]
		}
	}
	return nil
}

// Seed returns the map seed of the current or most recent match (0 before
// the first START).
func (r *Room) Seed() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.seed
}

// SessionSeq returns how many matches have been started (1 after first START).
func (r *Room) SessionSeq() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessionSeq
}

// HostCommand applies a host action with permission and legality checks.
// Only the host may issue any action. Legal transitions:
//
//	WARMUP:  Idle → Warmup, Ended → Warmup (restart-like), [Running → Warmup rejected]
//	START:   Warmup → Running, Idle → Running (single-player quick start)
//	ABORT:   Running → Ended
//	RESTART: Ended → Warmup
//
// START generates a fresh crypto/rand uint64 seed, passes it plus the
// seated player ids (join order) to SimLauncher.Launch, and stores the
// returned handle. ABORT aborts the active handle.
func (r *Room) HostCommand(playerID uint64, action Action) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if playerID != r.host {
		return ErrNotHost
	}

	switch action {
	case ActionSoloBots:
		if r.state != Idle && r.state != Warmup && r.state != Ended {
			return fmt.Errorf("%w: SoloBots from %s", ErrIllegalTransit, r.state)
		}
		if r.soloBots == 0 {
			r.soloBots = MaxSoloBots
		} else {
			r.soloBots = 0
		}
		return nil

	case ActionWarmup:
		// Entering warmup is allowed from Idle and from Ended ("play again,
		// but let people reconfigure first"); it must not interrupt a match.
		if r.state != Idle && r.state != Ended {
			return fmt.Errorf("%w: Warmup from %s", ErrIllegalTransit, r.state)
		}
		seed, playerIDs, soloLauncher, err := r.prepareLaunchLocked()
		if err != nil {
			return err
		}
		r.launchWarmupLocked(seed, playerIDs, soloLauncher)
		return nil

	case ActionStart:
		if r.state != Warmup && r.state != Idle {
			return fmt.Errorf("%w: Start from %s", ErrIllegalTransit, r.state)
		}
		seed, playerIDs, soloLauncher, err := r.prepareLaunchLocked()
		if err != nil {
			return err
		}
		// Launch is invoked while holding the room lock to keep the
		// transition atomic (no ABORT can interleave between the state check
		// and storing the handle). Contract: Launch must be quick and must not
		// call back into this Room, or it will deadlock.
		if r.match != nil {
			r.match.Abort()
		}
		var handle MatchHandle
		if soloLauncher != nil {
			handle = soloLauncher.LaunchWithBots(seed, playerIDs, r.soloBots)
		} else {
			handle = r.launcher.Launch(seed, playerIDs)
		}
		r.seed = seed
		r.match = handle
		r.lastMatch = handle
		r.aborted = false
		r.sessionSeq++
		r.state = Running
		return nil

	case ActionAbort:
		if r.state != Running {
			return fmt.Errorf("%w: Abort from %s", ErrIllegalTransit, r.state)
		}
		r.aborted = true
		if r.match != nil {
			r.match.Abort()
			r.match = nil
		}
		r.state = Ended
		return nil

	case ActionRestart:
		if r.state != Ended {
			return fmt.Errorf("%w: Restart from %s", ErrIllegalTransit, r.state)
		}
		// Ended → Warmup：房间保留、立即装配热身实例（"局散房不散"，玩家回到
		// 可漫游/改码状态等待下一局）。
		seed, playerIDs, soloLauncher, err := r.prepareLaunchLocked()
		if err != nil {
			return err
		}
		r.launchWarmupLocked(seed, playerIDs, soloLauncher)
		return nil

	default:
		return fmt.Errorf("room: unknown action %d", int(action))
	}
}

// prepareLaunchLocked runs the shared launch preparation for WARMUP, START
// and RESTART, in a fixed error-precedence order: seated players →
// configured launcher → fresh crypto/rand seed → join-order roster →
// SoloBotLauncher capability when solo bots are configured. Nothing is
// mutated on failure. Caller holds mu.
func (r *Room) prepareLaunchLocked() (seed uint64, playerIDs []uint64, soloLauncher SoloBotLauncher, err error) {
	if len(r.members) == 0 {
		return 0, nil, nil, ErrNoPlayers
	}
	if r.launcher == nil {
		return 0, nil, nil, ErrNoLauncher
	}
	seed, err = newSeed()
	if err != nil {
		return 0, nil, nil, fmt.Errorf("room: generate seed: %w", err)
	}
	playerIDs = make([]uint64, len(r.joinOrder))
	copy(playerIDs, r.joinOrder)
	if r.soloBots > 0 {
		var ok bool
		soloLauncher, ok = r.launcher.(SoloBotLauncher)
		if !ok {
			return 0, nil, nil, ErrNoSoloBots
		}
	}
	return seed, playerIDs, soloLauncher, nil
}

// launchWarmupLocked is the shared WARMUP/RESTART tail: move to Warmup and
// immediately assemble a warmup instance ("局散房不散" — the room persists,
// players return to roaming/reconfiguring while awaiting the next match).
// LaunchWarmup 须快（异步装配，同 Launch 契约：不得回调 Room）。Caller holds mu.
func (r *Room) launchWarmupLocked(seed uint64, playerIDs []uint64, soloLauncher SoloBotLauncher) {
	r.state = Warmup
	if soloLauncher != nil {
		r.match = soloLauncher.LaunchWarmupWithBots(seed, playerIDs, r.soloBots)
	} else {
		r.match = r.launcher.LaunchWarmup(seed, playerIDs)
	}
}

// EndMatch moves a Running room to Ended after a match finished on its own
// (time up, or the sim reported completion). It is idempotent. It does not
// add scores; the caller reports those via AddMatchResult first.
func (r *Room) EndMatch() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == Running {
		if r.match != nil {
			r.match.Abort()
		}
		r.state = Ended
		r.match = nil
	}
}

// EndWarmup moves a Warmup room to Ended when its warmup instance was
// terminated externally with no replacement (idle-room reclamation, audit
// S-26). Warmup has no natural finish, so without this transition the room
// would sit in Warmup forever — and WARMUP is an illegal transition from
// Warmup, so returning players could never re-enter warmup. Idempotent;
// no-op on any other state; never touches session scores.
func (r *Room) EndWarmup() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.state == Warmup {
		if r.match != nil {
			r.match.Abort()
		}
		r.state = Ended
		r.match = nil
	}
}

// AddMatchResult accumulates one match's scores into the Session board.
// Players not currently seated still keep their accumulated points (they
// may rejoin). Safe to call in any state.
func (r *Room) AddMatchResult(scores map[uint64]int32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, pts := range scores {
		r.session[id] += pts
	}
}

// ScoreRow is one row of the Session leaderboard snapshot.
type ScoreRow struct {
	PlayerID uint64
	Nick     string
	Score    int32
}

// SessionScores returns the Session leaderboard sorted by score desc, then
// player id asc for stability. It is a snapshot; callers may keep it.
func (r *Room) SessionScores() []ScoreRow {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows := make([]ScoreRow, 0, len(r.session))
	for id, pts := range r.session {
		rows = append(rows, ScoreRow{
			PlayerID: id,
			Nick:     r.nickLocked(id),
			Score:    pts,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		return cmp.Or(
			cmp.Compare(rows[j].Score, rows[i].Score),       // score desc
			cmp.Compare(rows[i].PlayerID, rows[j].PlayerID), // tie: id asc
		) < 0
	})
	return rows
}

// nickLocked returns the member's nick, or "" if not seated. Caller holds mu.
func (r *Room) nickLocked(playerID uint64) string {
	if m, ok := r.members[playerID]; ok && m.Nick != "" {
		return m.Nick
	}
	if n, ok := r.pendingNicks[playerID]; ok {
		return n
	}
	return ""
}

// StateBroadcast builds the room lifecycle broadcast (ombv1.EvRoomState):
// current state, seated robot count, and the host's nick ("" if the host is
// not seated — e.g. between the host's own leave and room teardown).
func (r *Room) StateBroadcast() *ombv1.EvRoomState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return &ombv1.EvRoomState{
		State:        r.state.protoState(),
		RobotsOnline: uint32(len(r.members)),
		HostNick:     r.nickLocked(r.host),
		SoloBots:     r.soloBots,
	}
}

// newSeed generates a uniform random uint64 via crypto/rand.
// rand.Uint64 does not exist in the standard library, so we build it from
// two 32-bit halves to avoid modulo bias.
func newSeed() (uint64, error) {
	hi, err := rand.Int(rand.Reader, big.NewInt(1<<32))
	if err != nil {
		return 0, err
	}
	lo, err := rand.Int(rand.Reader, big.NewInt(1<<32))
	if err != nil {
		return 0, err
	}
	return hi.Uint64()<<32 | lo.Uint64(), nil
}
