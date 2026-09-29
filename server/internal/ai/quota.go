package ai

import (
	"context"
	"fmt"
	"sync"
)

// 配额默认值（ADR-0010 r2）。
const (
	DefaultPlayerRounds   uint32 = 20        // 每玩家每局提示轮次
	DefaultPlayerTokens   uint32 = 300_000   // 每玩家每局 token 预算
	DefaultGlobalTokens   uint32 = 2_000_000 // 单局全局护栏
	DefaultMaxConcurrency        = 20        // 全局并发（对齐 DeepSeek 官方，可配置）
)

// QuotaConfig 配额参数；零值字段由 NewQuotaService 填默认值。
type QuotaConfig struct {
	PlayerRounds   uint32 // 每玩家每局轮次（默认 20）
	PlayerTokens   uint32 // 每玩家每局 token（默认 300k）
	GlobalTokens   uint32 // 单局全局护栏 token（默认 2M，触顶全员禁）
	MaxConcurrency int    // 全局并发上限（默认 20）
}

// DefaultQuotaConfig 返回 ADR-0010 r2 规定的默认配额。
func DefaultQuotaConfig() QuotaConfig {
	return QuotaConfig{
		PlayerRounds:   DefaultPlayerRounds,
		PlayerTokens:   DefaultPlayerTokens,
		GlobalTokens:   DefaultGlobalTokens,
		MaxConcurrency: DefaultMaxConcurrency,
	}
}

// playerQuota 单玩家记账状态（受 QuotaServiceImpl.mu 保护）。
type playerQuota struct {
	roundsUsed uint32 // 已消耗轮次（TryAcquire 签发时预留）
	tokensUsed uint32 // 已消耗 token（Commit 时按实际 usage 入账）
	inFlight   bool   // 单玩家串行：同玩家在途请求 ≤1
}

// QuotaServiceImpl 实现 contract.go 的 QuotaService。
//
// 规则（ADR-0010 r2）：
//   - 双轨：每玩家每局 PlayerRounds 轮 + PlayerTokens token；
//   - 单玩家串行：inFlight 标记，同玩家第二笔 TryAcquire → ErrBusy；
//   - 全局并发：带容量计数信号量（chan struct{}，容量 MaxConcurrency），
//     等待期间 ctx 取消 → ErrConcurrency；
//   - 全局护栏：globalUsed ≥ GlobalTokens 后所有玩家 TryAcquire →
//     ErrGlobalGuardrail（"本局 AI 额度已尽"）；
//   - 热身场同池：无独立状态，Warmup 与正式局共用同一记账；
//   - Restart：清空全部记账并递增 matchSeq，旧 lease 的 Commit 静默丢弃。
//
// 语义约定：
//   - 轮次在 TryAcquire 签发时即预留（失败不退，玩家已发出提示）；
//     token 在 Commit 时按 Provider 返回的实际用量入账；
//   - Provider 出错也必须调用 Commit(lease, Usage{}) 以释放串行位/并发位；
//   - Commit 与 TryAcquire 必须配对；重复 Commit 或跨局旧 lease 不入账、
//     不重复释放并发位。
type QuotaServiceImpl struct {
	mu         sync.Mutex
	cfg        QuotaConfig
	players    map[uint64]*playerQuota
	globalUsed uint64        // 本局全局累计 token（护栏）
	matchSeq   int           // Restart 递增；签发时写入 Lease
	slots      chan struct{} // 全局并发信号量（跨 Restart 稳定，物理资源）
}

var _ QuotaService = (*QuotaServiceImpl)(nil)

// NewQuotaService 创建配额服务；cfg 零值字段取 DefaultQuotaConfig。
func NewQuotaService(cfg QuotaConfig) *QuotaServiceImpl {
	d := DefaultQuotaConfig()
	if cfg.PlayerRounds == 0 {
		cfg.PlayerRounds = d.PlayerRounds
	}
	if cfg.PlayerTokens == 0 {
		cfg.PlayerTokens = d.PlayerTokens
	}
	if cfg.GlobalTokens == 0 {
		cfg.GlobalTokens = d.GlobalTokens
	}
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = d.MaxConcurrency
	}
	return &QuotaServiceImpl{
		cfg:      cfg,
		players:  make(map[uint64]*playerQuota),
		matchSeq: 1,
		slots:    make(chan struct{}, cfg.MaxConcurrency),
	}
}

// TryAcquire 尝试为玩家获取一次调用资格。
//
// 顺序：先占全局并发位（ctx 可取消等待），再在单一临界区内完成
// 护栏 → 串行 → 轮次 → token 四项检查并预留轮次——检查与预留原子完成，
// 避免 Restart 边界出现跨局撕裂。
func (s *QuotaServiceImpl) TryAcquire(ctx context.Context, playerID uint64) (Lease, error) {
	select {
	case s.slots <- struct{}{}:
	case <-ctx.Done():
		return Lease{}, fmt.Errorf("%w: %w", ErrConcurrency, ctx.Err())
	}

	s.mu.Lock()
	if s.globalUsed >= uint64(s.cfg.GlobalTokens) {
		s.mu.Unlock()
		s.releaseSlot()
		return Lease{}, ErrGlobalGuardrail
	}
	pq := s.playerLocked(playerID)
	switch {
	case pq.inFlight:
		s.mu.Unlock()
		s.releaseSlot()
		return Lease{}, ErrBusy
	case pq.roundsUsed >= s.cfg.PlayerRounds:
		s.mu.Unlock()
		s.releaseSlot()
		return Lease{}, ErrRoundsExhausted
	case pq.tokensUsed >= s.cfg.PlayerTokens:
		s.mu.Unlock()
		s.releaseSlot()
		return Lease{}, ErrTokensExhausted
	}
	pq.roundsUsed++
	pq.inFlight = true
	lease := Lease{
		PlayerID:   playerID,
		MatchSeq:   s.matchSeq,
		RoundsLeft: s.cfg.PlayerRounds - pq.roundsUsed,
	}
	s.mu.Unlock()
	return lease, nil
}

// Commit 记录实际消耗并释放串行位与并发位。
// lease 失效（局已 Restart）时静默丢弃并返回 false——AI 迟到结果不得入账新局，
// 但其占用的物理并发位仍需释放。重复 Commit（同玩家无在途请求）同样返回 false。
func (s *QuotaServiceImpl) Commit(lease Lease, usage Usage) bool {
	s.mu.Lock()
	if lease.MatchSeq != s.matchSeq {
		s.mu.Unlock()
		s.releaseSlot()
		return false
	}
	pq, ok := s.players[lease.PlayerID]
	if !ok || !pq.inFlight {
		// 未配对或重复 Commit：不入账、不释放并发位（未持有）。
		s.mu.Unlock()
		return false
	}
	pq.inFlight = false
	pq.tokensUsed += usage.TokensDelta
	s.globalUsed += uint64(usage.TokensDelta)
	s.mu.Unlock()
	s.releaseSlot()
	return true
}

// Snapshot 当前配额状态（下发 EvAiUsage / HUD）。
// token 余量单位为千 token（K）：300k 预算 → 300，2M 护栏 → 2000。
func (s *QuotaServiceImpl) Snapshot(playerID uint64) (roundsLeft uint32, tokensLeftK uint32, globalLeftK uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	roundsLeft = s.cfg.PlayerRounds
	tokensLeft := uint64(s.cfg.PlayerTokens)
	if pq, ok := s.players[playerID]; ok {
		if pq.roundsUsed < s.cfg.PlayerRounds {
			roundsLeft = s.cfg.PlayerRounds - pq.roundsUsed
		} else {
			roundsLeft = 0
		}
		if used := uint64(pq.tokensUsed); used < tokensLeft {
			tokensLeft -= used
		} else {
			tokensLeft = 0
		}
	}
	globalLeft := uint64(0)
	if s.globalUsed < uint64(s.cfg.GlobalTokens) {
		globalLeft = uint64(s.cfg.GlobalTokens) - s.globalUsed
	}
	return roundsLeft, uint32(tokensLeft / 1000), uint32(globalLeft / 1000)
}

// Restart 重置全部记账（轮次/token/护栏/在途标记）并递增局序号。
// 在途的旧请求稍后 Commit 时按 MatchSeq 失配丢弃；并发信号量是物理资源，
// 跨 Restart 复用同一实例（Restart 不清空，由旧 lease 的 Commit 归还）。
func (s *QuotaServiceImpl) Restart() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.players = make(map[uint64]*playerQuota)
	s.globalUsed = 0
	s.matchSeq++
}

// CurrentMatchSeq 返回当前局序号（glue/测试用）。
func (s *QuotaServiceImpl) CurrentMatchSeq() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.matchSeq
}

// playerLocked 取或建玩家记账项（调用方持锁）。
func (s *QuotaServiceImpl) playerLocked(playerID uint64) *playerQuota {
	pq, ok := s.players[playerID]
	if !ok {
		pq = &playerQuota{}
		s.players[playerID] = pq
	}
	return pq
}

// releaseSlot 归还一个并发位。仅持位者调用；default 分支防御
// 未配对调用导致的死锁（正常路径必有空位可收）。
func (s *QuotaServiceImpl) releaseSlot() {
	select {
	case <-s.slots:
	default:
	}
}
