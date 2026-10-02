package glue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
	"github.com/modenicheng/oh-my-bot/server/internal/snapshot"
)

// AIService 房间级 AI 改码服务：Quota + Provider + 手册语料。
// 每房间一份（quota 房间作用域：Warmup 起生效、新局 Restart 重置）；
// provider/manual 由 Hub 工厂从同一 ServerConfig 派生。
// nil-safe：未配置 key / enabled=false 时为 nil，AiPrompt 走禁用回执。
type AIService struct {
	quota         *ai.QuotaServiceImpl
	provider      ai.Provider
	manual        []string
	playerTokensK uint32 // AiQuota 回执的 tokens_used_k 换算基数
}

// NewAIService 装配 AI 服务（cfg 已含 key；缺 key 或未启用返回 nil——安全禁用）。
func NewAIService(cfg ai.ServerConfig, manual []string) *AIService {
	if !cfg.AI.Enabled || cfg.APIKey == "" {
		return nil
	}
	provider := ai.NewDeepSeekProvider(cfg.APIKey)
	provider.Model = cfg.AI.Model
	provider.Endpoint = cfg.AI.Endpoint
	provider.HTTPClient = &http.Client{Timeout: cfg.AI.Timeout}
	return &AIService{
		quota:         ai.NewQuotaService(cfg.Quota),
		provider:      provider,
		manual:        manual,
		playerTokensK: cfg.Quota.PlayerTokens / 1000,
	}
}

// Restart 重置配额记账（新一轮热身、重开，或从 Idle 直接开正式局）。
// 热身进入紧接的正式局不重置；在途旧请求按局序号失配丢弃。
func (s *AIService) Restart() {
	if s != nil {
		s.quota.Restart()
	}
}

// aiScriptSnapshot 持 rc.mu 读取的玩家当前脚本快照（源码原文+rev）。
type aiScriptSnapshot struct {
	source     string
	rev        uint32
	perception string
}

const aiMaxPromptRunes = 500

// aiClientScriptID AI 改码 ScriptResult 的保留 client_script_id：
// 客户端编辑器区分「自己提交的回执」与「AI 改码回执」（0 = 服务器保留）。
const aiClientScriptID = 0

// handleAiPromptLocked 处理一次玩家 AI 改码请求（调用方持 rc.mu；
// 网络等待绝不发生在锁内）。
//
// 时序：
//  1. 锁内快照：match 有效、AI 可用、玩家当前脚本源码+rev、配额局序号；
//  2. goroutine 锁外执行 Agent 编排（TryAcquire→Provider.Complete→Commit，
//     provider 网络 IO 数秒——rc.mu 只在首尾各持一次，不阻塞 60Hz tick）；
//  3. 重新持锁落地：仍同一局时经 LoadIfRev 乐观并发写脚本（手动热更后
//     旧 AI 结果不覆盖），定向回执 + EvAiUsage 进事件管线。
func (m *Match) handleAiPromptLocked(pid uint64, text string) {
	if !m.activeLocked() {
		return
	}
	sess := m.rc.sessions[pid]
	if sess == nil {
		return
	}
	var valid bool
	text, valid = normalizeAIPrompt(text)
	if !valid {
		sess.SendReliable(say("AI 请求失败：指令不能为空且最多 500 字"))
		return
	}
	svc := m.ai
	if svc == nil || svc.provider == nil {
		sess.SendReliable(say("AI 未启用：服务器未配置 DEEPSEEK_API_KEY（见 config.yaml ai.enabled 与 .env）"))
		return
	}
	snap := m.aiScriptSnapshot(pid)
	matchSeq := svc.quota.CurrentMatchSeq()
	go m.runAiPrompt(sess, pid, text, svc, snap, matchSeq)
}

func normalizeAIPrompt(text string) (string, bool) {
	text = strings.TrimSpace(text)
	return text, text != "" && utf8.RuneCountInString(text) <= aiMaxPromptRunes
}

// aiScriptSnapshot 读取玩家当前源码与同 tick 的合法感知（调用方持 rc.mu）。
// 感知与脚本 scan() 同源：动态实体受范围和墙体遮挡裁剪，Uplink 个人
// 冷却仅保留当前玩家；序列化 DTO 不含昵称、颜色或其他玩家私有状态。
func (m *Match) aiScriptSnapshot(pid uint64) aiScriptSnapshot {
	rid, ok := m.robotOf[pid]
	if !ok {
		return aiScriptSnapshot{}
	}
	snap := aiScriptSnapshot{}
	if rt := m.scriptPool.RuntimeOf(rid); rt != nil {
		snap.source, snap.rev = rt.Source(), rt.Rev()
	}
	wv := m.sim.WorldView()
	self, ok := robotOf(wv, rid)
	if !ok {
		return snap
	}
	obs := snapshot.BuildObservation(snapshot.World{
		FrameView: wv.Frame, Robots: wv.Robots, Projectiles: wv.Projectiles,
		Cores: wv.Cores, HealthPacks: wv.HealthPacks, Uplinks: wv.Uplinks,
	}, m.wallIX, rid, 0, wv.ScanRadius(rid))
	snap.perception = marshalAIPerception(self, obs)
	return snap
}

func marshalAIPerception(self sim.RobotView, obs sim.Observation) string {
	type vec struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	type robot struct {
		ID       uint32  `json:"id"`
		Position vec     `json:"position"`
		Velocity vec     `json:"velocity"`
		HP       float64 `json:"hp"`
		Energy   float64 `json:"energy,omitempty"`
		Shield   bool    `json:"shield,omitempty"`
		Dead     bool    `json:"dead,omitempty"`
	}
	type object struct {
		ID        uint32 `json:"id"`
		Position  vec    `json:"position"`
		Value     int32  `json:"value,omitempty"`
		Available *bool  `json:"available,omitempty"`
		Respawn   uint32 `json:"respawn_in_s,omitempty"`
	}
	type uplink struct {
		ID         uint32  `json:"id"`
		Position   vec     `json:"position"`
		Main       bool    `json:"main,omitempty"`
		Active     bool    `json:"active"`
		HackingID  uint32  `json:"hacking_id,omitempty"`
		Progress   float64 `json:"progress_s,omitempty"`
		MyCooldown uint32  `json:"my_cooldown_s,omitempty"`
	}
	type projectile struct {
		ID       uint32  `json:"id"`
		Owner    uint32  `json:"owner"`
		Position vec     `json:"position"`
		Heading  float64 `json:"heading"`
	}
	type wall struct {
		ID  uint32 `json:"id"`
		Min vec    `json:"min"`
		Max vec    `json:"max"`
	}
	toVec := func(v sim.Vec2) vec { return vec{X: v.X, Y: v.Y} }
	phase := "OUTER_RING"
	if obs.Frame.Phase == sim.PhaseCoreOpen {
		phase = "CORE_OPEN"
	}
	doc := struct {
		Tick        uint32       `json:"tick"`
		Phase       string       `json:"phase"`
		TimeLeft    uint32       `json:"time_left_s"`
		Self        robot        `json:"self"`
		Robots      []robot      `json:"robots"`
		Cores       []object     `json:"cores"`
		HealthPacks []object     `json:"health_packs"`
		Uplinks     []uplink     `json:"uplinks"`
		Projectiles []projectile `json:"projectiles"`
		Walls       []wall       `json:"walls"`
	}{Tick: obs.Frame.Tick, Phase: phase, TimeLeft: obs.Frame.TimeLeftS}
	doc.Self = robot{ID: self.ID, Position: toVec(self.Pos), Velocity: toVec(self.Vel), HP: float64(self.HpX10) / 10, Energy: float64(self.EnergyX10) / 10, Shield: self.ShieldOn, Dead: self.Dead}
	for _, r := range obs.Robots {
		if r.ID == self.ID {
			continue
		}
		doc.Robots = append(doc.Robots, robot{ID: r.ID, Position: toVec(r.Pos), Velocity: toVec(r.Vel), HP: float64(r.HpX10) / 10, Shield: r.ShieldOn, Dead: r.Dead})
	}
	for _, c := range obs.Cores {
		if c.Alive {
			doc.Cores = append(doc.Cores, object{ID: c.ID, Position: toVec(c.Pos), Value: c.Value})
		}
	}
	for _, h := range obs.HealthPacks {
		available := h.Available
		doc.HealthPacks = append(doc.HealthPacks, object{ID: h.ID, Position: toVec(h.Pos), Available: &available, Respawn: h.RespawnInS})
	}
	for _, u := range obs.Uplinks {
		doc.Uplinks = append(doc.Uplinks, uplink{ID: u.ID, Position: toVec(u.Pos), Main: u.Main, Active: u.Active, HackingID: u.HackingID, Progress: u.ProgressS, MyCooldown: u.PersonalCDs[self.ID]})
	}
	for _, p := range obs.Projectiles {
		doc.Projectiles = append(doc.Projectiles, projectile{ID: p.ID, Owner: p.Owner, Position: toVec(p.Pos), Heading: p.Heading})
	}
	if obs.Frame.Map != nil {
		for _, w := range obs.Frame.Map.Walls {
			doc.Walls = append(doc.Walls, wall{ID: w.ID, Min: toVec(w.Min), Max: toVec(w.Max)})
		}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return ""
	}
	return string(raw)
}

// snapshotScripts Agent 编排用的只读桥：CurrentScript 喂快照（锁外无访问），
// SubmitSource 空操作——真正的脚本落地在结果阶段持 rc.mu 显式执行。
type snapshotScripts struct{ snap aiScriptSnapshot }

func (s snapshotScripts) CurrentScript(uint64) (string, uint32) { return s.snap.source, s.snap.rev }
func (snapshotScripts) SubmitSource(uint64, uint32, string) (uint32, bool, error) {
	return 0, false, nil
}

// runAiPrompt 锁外执行 Agent 编排，再持锁落地结果。
func (m *Match) runAiPrompt(_ *Session, pid uint64, text string, svc *AIService, snap aiScriptSnapshot, matchSeq int) {
	agent := ai.NewAgent(svc.quota, svc.provider, snapshotScripts{snap: snap})
	agent.SetManual(svc.manual)
	agent.SetPerception(snap.perception)
	outcome, err := agent.HandlePrompt(context.Background(), pid, text)

	m.rc.mu.Lock()
	defer m.rc.mu.Unlock()
	// Reconnect/takeover may replace the Session while the provider is running.
	// Always deliver to the currently bound owner, never to a stale socket.
	sess := m.rc.sessions[pid]
	if sess == nil {
		return
	}
	m.handleAgentResult(sess, pid, outcome, err, svc, snap, matchSeq)
}

// handleAgentResult 持 rc.mu 落地：脚本写入（乐观并发）+ 定向回执 +
// EvAiUsage 进事件管线（正式局落 Match Event Log + 投影；不广播——
// 配额事实属个人，走定向 AiQuota）。
//
// 错误/拒绝一律定向，文案只含类别不含 prompt 原文、key 或上游响应体。
func (m *Match) handleAgentResult(sess *Session, pid uint64, outcome ai.HandleOutcome, err error, svc *AIService, snap aiScriptSnapshot, matchSeq int) {
	stillSameMatch := m.activeLocked() && svc.quota.CurrentMatchSeq() == matchSeq
	if err != nil {
		sess.SendReliable(say("AI 请求失败：" + aiRejectText(err)))
		m.sendAIUsageLocked(sess, pid, svc, outcome.Usage, stillSameMatch)
		return
	}

	if stillSameMatch {
		ms := matchScripts{m: m}
		newRev, accepted, serr := ms.SubmitSource(pid, snap.rev, outcome.Result.NewScript)
		switch {
		case serr != nil:
			sess.SendReliable(say("AI 生成脚本编译失败，已丢弃（旧脚本继续运行）：" + serr.Error()))
		case !accepted:
			sess.SendReliable(say("AI 改码未生效：脚本已被手动更新，AI 结果丢弃（旧脚本继续运行）"))
		default:
			sess.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
				Kind: &ombv1.ServerEvent_ScriptResult{ScriptResult: &ombv1.EvScriptResult{
					ClientScriptId: aiClientScriptID, Ok: true, ScriptRev: newRev,
				}},
			}}})
		}
	}

	if outcome.Result.Explain != "" {
		sess.SendReliable(say("AI 改动说明：" + outcome.Result.Explain))
	}
	m.sendAIUsageLocked(sess, pid, svc, outcome.Usage, stillSameMatch)
}

func (m *Match) sendAIUsageLocked(sess *Session, pid uint64, svc *AIService, usage ai.Usage, stillSameMatch bool) {
	if usage.RoundsDelta == 0 {
		return
	}
	roundsLeft, tokensLeftK, globalLeftK := svc.quota.Snapshot(pid)
	usedK := svc.playerTokensK
	if tokensLeftK < usedK {
		usedK -= tokensLeftK
	} else {
		usedK = 0
	}
	sess.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_AiQuota{AiQuota: &ombv1.EvAiQuota{
			RoundsLeft: roundsLeft, TokensUsedK: usedK, GlobalTokensLeftK: globalLeftK,
		}},
	}}})
	if stillSameMatch {
		if rid, ok := m.robotOf[pid]; ok {
			m.emitNonSimEvent(&ombv1.ServerEvent{Kind: &ombv1.ServerEvent_AiUsage{AiUsage: &ombv1.EvAiUsage{
				Robot: rid, RoundsDelta: usage.RoundsDelta,
				TokensDelta: usage.TokensDelta, GlobalLeftK: usage.GlobalLeftK,
			}}})
		}
	}
}

// matchScripts Match 作用域的脚本落地桥（调用方持 rc.mu）。
type matchScripts struct{ m *Match }

// SubmitSource 乐观并发落地：仅当 rev 未被手动热更超越时装载（LoadIfRev）。
// 编译失败返回 accepted=false + err 摘要（旧版继续跑，Hot Swap 语义）。
func (ms *matchScripts) SubmitSource(playerID uint64, rev uint32, source string) (uint32, bool, error) {
	rid, ok := ms.m.robotOf[playerID]
	if !ok {
		return 0, false, fmt.Errorf("player not in match")
	}
	rt := ms.m.scriptPool.RuntimeOf(rid)
	if rt == nil {
		rt = script.NewGojaRuntime(script.Config{})
		ms.m.scriptPool.Register(rid, rt)
		ms.m.runtimes[rid] = rt
	}
	newRev, accepted, err := rt.LoadIfRev(rev, source)
	if accepted {
		ms.m.sendScriptLogsLocked(rid, rt)
	}
	return newRev, accepted, err
}

// emitNonSimEvent sends a non-sim match event through the same observable
// pipeline: scored matches persist it, the projector consumes it, and clients
// receive the public usage counters (never prompts, scripts, or credentials).
func (m *Match) emitNonSimEvent(ev *ombv1.ServerEvent) {
	if m.log != nil {
		m.log.OnEvent(m.tick, ev)
	}
	glueSink{m: m}.OnEvent(m.tick, ev)
}

// aiRejectText 拒因/错误转玩家可读文案（不含 prompt 原文、key、上游响应体）。
func aiRejectText(err error) string {
	var perr *ai.ProviderError
	if errors.As(err, &perr) {
		switch perr.Category {
		case ai.CatRateLimited:
			return "上游限流，请稍后再试"
		case ai.CatNetwork:
			return "网络异常，请稍后再试"
		case ai.CatClient:
			return "服务端 AI 配置异常（已记录）"
		case ai.CatProvider:
			return "模型响应异常，请重试"
		}
	}
	switch {
	case errors.Is(err, ai.ErrRoundsExhausted):
		return "本局 AI 轮次已用完"
	case errors.Is(err, ai.ErrTokensExhausted):
		return "本局 AI token 预算已用完"
	case errors.Is(err, ai.ErrGlobalGuardrail):
		return "本局全局 AI 额度已尽"
	case errors.Is(err, ai.ErrBusy):
		return "上一个 AI 请求仍在处理中"
	case errors.Is(err, ai.ErrConcurrency):
		return "AI 并发已满，请稍后再试"
	}
	return "内部错误（已记录）"
}
