package glue

import (
	"fmt"
	"sort"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/snippet"
)

// Snippet 驾驶辅助 glue（v0.3 §9-2）。
//
// 配置权威存于 RoomConn.snippets（按 playerID）：warmup→running、Restart
// 都新建 Match，配置在 NewMatch 时重新应用到新 runtime；玩家显式离开
// （身份释放）时清理。socket 断开（Unregister）不清——重连保留。
//
// 运行时：配置只作用于该玩家的 GojaRuntime（LoadSnippets 全量重组合，
// 失败保旧）。snippet-only 玩家（无玩家源码）同样持有 runtime；
// 清空全部 snippet 且无玩家源码时注销 runtime（v2 语义：无脚本结果
// = 各轴中立，无需显式清轴）。

// ConfigureSnippets 处理 SnippetConfig 上行。Warmup 状态先于异步 Match
// 发布，故无 active match 时也必须校验、保存并回执；新 Match 会从房间
// 快照恢复配置。任何合法玩家请求都有 EvSnippetResult，不得静默悬空。
func (s *Session) ConfigureSnippets(cfg *ombv1.SnippetConfig) {
	if cfg == nil {
		return
	}
	s.withRoom(func(rc *RoomConn) {
		if m := rc.match; m != nil && m.activeLocked() {
			m.configureSnippetsLocked(s.playerID, cfg)
			return
		}
		applied, err := validateSnippetConfig(cfg)
		if err != nil {
			sendSnippetResult(s, false, err.Error(), settingsToProto(rc.snippets[s.playerID]), 0)
			return
		}
		sort.Slice(applied, func(i, j int) bool { return applied[i].Kind < applied[j].Kind })
		rc.snippets[s.playerID] = append([]snippet.Setting{}, applied...)
		sendSnippetResult(s, true, "", settingsToProto(applied), 0)
	})
}

// configureSnippetsLocked 校验 → 应用 → 回执（调用方持 rc.mu）。
// 严格验证全部条目（未知 kind/重复 kind/超量/参数范围/路径点）；
// 任一条目非法则整单拒绝保旧（runtime 与 rc.snippets 均不动）。
func (m *Match) configureSnippetsLocked(pid uint64, cfg *ombv1.SnippetConfig) {
	sess := m.rc.sessions[pid]
	if sess == nil {
		return
	}
	rid, ok := m.robotOf[pid]
	if !ok {
		// 中途入房玩家不在本局成员快照里：与 SubmitScript 一致发 nack。
		m.sendSnippetResultLocked(sess, false, "not in match", nil, 0)
		return
	}
	applied, err := validateSnippetConfig(cfg)
	if err != nil {
		old, oldRev := m.currentSnippetsLocked(pid, rid)
		m.sendSnippetResultLocked(sess, false, err.Error(), old, oldRev)
		return
	}
	// 稳定排序：同一配置集合的组合顺序恒定（kind 顺序 = catalog 顺序）。
	sort.Slice(applied, func(i, j int) bool { return applied[i].Kind < applied[j].Kind })

	rev, err := m.applySnippetsLocked(rid, applied)
	if err != nil {
		old, oldRev := m.currentSnippetsLocked(pid, rid)
		m.sendSnippetResultLocked(sess, false, err.Error(), old, oldRev)
		return
	}
	m.rc.snippets[pid] = append([]snippet.Setting{}, applied...)
	m.sendSnippetResultLocked(sess, true, "", settingsToProto(applied), rev)
}

// currentSnippetsLocked 失败回执用的“现役配置”视图：runtime 在则读
// runtime（与执行事实一致，含旧 rev），否则读房间保存值（无 runtime =
// 未生效，rev 0 仅为回执完整性）。
func (m *Match) currentSnippetsLocked(pid uint64, rid uint32) ([]*ombv1.SnippetSetting, uint32) {
	if rt := m.scriptPool.RuntimeOf(rid); rt != nil {
		return settingsToProto(rt.Snippets()), rt.Rev()
	}
	return settingsToProto(m.rc.snippets[pid]), 0
}

// applySnippetsLocked 把已验证配置落到该 robot 的 runtime，返回回执 rev。
// 全量替换语义；snippet-only 合法；清空 + 无玩家源码 → 注销 runtime。
func (m *Match) applySnippetsLocked(rid uint32, cfg []snippet.Setting) (uint32, error) {
	rt := m.scriptPool.RuntimeOf(rid)
	if rt == nil {
		if len(cfg) == 0 {
			return 0, nil // 本来就没有
		}
		rt = script.NewGojaRuntime(script.Config{})
		if err := rt.LoadSnippets(cfg); err != nil {
			rt.Close()
			return 0, fmt.Errorf("装载失败：%w", err)
		}
		m.scriptPool.Register(rid, rt)
		m.runtimes[rid] = rt
		return rt.Rev(), nil
	}
	if len(cfg) == 0 && rt.Source() == "" {
		// snippet-only 清空：runtime 无存在意义，注销释放配额
		//（v2 语义下无脚本结果自动各轴中立）。
		m.scriptPool.Unregister(rid)
		delete(m.runtimes, rid)
		return 0, nil
	}
	if err := rt.LoadSnippets(cfg); err != nil {
		return rt.Rev(), fmt.Errorf("装载失败：%w", err) // 保旧：现役 VM 不动
	}
	return rt.Rev(), nil
}

// applySavedSnippets 在 NewMatch 装配期从不可变玩家快照恢复配置。
// launcher 在 rc.mu 内深拷贝 Snippets；NewMatch 可在锁外安全组装，且不会
// 与 ConfigureSnippets/LeaveRoom 对 RoomConn.snippets 的写入发生数据竞争。
func (m *Match) applySavedSnippets(players map[uint64]SessionInfo) {
	for pid, info := range players {
		cfg := append([]snippet.Setting{}, info.Snippets...)
		if len(cfg) == 0 {
			continue
		}
		rid, ok := m.robotOf[pid]
		if !ok || m.botRobots[rid] {
			continue
		}
		if _, err := m.applySnippetsLocked(rid, cfg); err != nil {
			continue
		}
	}
}

// syncRoomSnippetsLocked 在异步 Match 发布前，把装配期间发生的配置变更
// 合并到候选 runtime。调用方持 rc.mu；配置均已在写入时验证，失败时保留
// 候选 runtime 的旧版本，随后 bootstrap 回执真实现役状态。
func (m *Match) syncRoomSnippetsLocked() {
	for pid := range m.robotOf {
		rid, ok := m.robotOf[pid]
		if !ok || m.botRobots[rid] {
			continue
		}
		cfg := append([]snippet.Setting{}, m.rc.snippets[pid]...)
		_, _ = m.applySnippetsLocked(rid, cfg)
	}
}

// sendSnippetStateLocked 在玩家 bootstrap/reconnect 时补发现役配置与
// 官方源码。它不是一次配置变更，仅用于让客户端以服务器事实覆盖本地确认态。
func (m *Match) sendSnippetStateLocked(sess *Session) {
	if sess == nil {
		return
	}
	rid, ok := m.robotOf[sess.playerID]
	if !ok {
		return
	}
	applied, rev := m.currentSnippetsLocked(sess.playerID, rid)
	m.sendSnippetResultLocked(sess, true, "", applied, rev)
}

// sendSnippetResultLocked 定向下发 SnippetConfig 回执（owner-only，
// 与 ScriptResult 同通道；不进 Match Event Log、不广播）。
func (m *Match) sendSnippetResultLocked(sess *Session, ok bool, errMsg string, applied []*ombv1.SnippetSetting, rev uint32) {
	sendSnippetResult(sess, ok, errMsg, applied, rev)
}

func sendSnippetResult(sess *Session, ok bool, errMsg string, applied []*ombv1.SnippetSetting, rev uint32) {
	if sess == nil || sess.SendReliable == nil {
		return
	}
	sess.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_SnippetResult{SnippetResult: &ombv1.EvSnippetResult{
			Ok: ok, Error: errMsg, Applied: applied, ScriptRev: rev, Sources: snippetSourceViews(),
		}},
	}}})
}

// ---- 协议 ↔ catalog 转换（本文件是 glue 内唯一转换点） ----

// validateSnippetConfig 严格验证全部条目并返回启用集合（保留上行顺序，
// 排序由调用方统一做）。规则：
//   - 每条 kind 必须已知（含 UNSPECIFIED 拒绝）；kind 不得重复；
//   - 总条数 ≤ 当前 catalog 数量；
//   - enabled 条目按模块 Validate 规范化（范围/NaN/路径点，坏值整单拒绝）；
//   - disabled 条目参数不校验（全量替换语义下等价于省略）。
func validateSnippetConfig(cfg *ombv1.SnippetConfig) ([]snippet.Setting, error) {
	if cfg == nil {
		return nil, nil
	}
	mods := snippet.Catalog()
	entries := cfg.GetSnippets()
	if len(entries) > len(mods) {
		return nil, fmt.Errorf("snippet 条目过多（%d > %d）", len(entries), len(mods))
	}
	seen := make(map[snippet.Kind]bool, len(entries))
	var out []snippet.Setting
	for _, e := range entries {
		if e == nil {
			continue
		}
		pk := e.GetKind()
		if pk == ombv1.SnippetKind_SNIPPET_UNSPECIFIED {
			return nil, fmt.Errorf("未知 snippet kind %d", pk)
		}
		k := snippet.KindFromProto(pk)
		mod := snippet.ModuleOf(k)
		if mod == nil {
			return nil, fmt.Errorf("未知 snippet kind %d", pk)
		}
		if seen[k] {
			return nil, fmt.Errorf("snippet kind %s 重复配置", pk.String())
		}
		seen[k] = true
		if !e.GetEnabled() {
			continue
		}
		s, err := mod.Validate(snippet.Setting{Kind: k, P1: e.GetP1(), P2: e.GetP2(), S1: e.GetS1()})
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// settingsToProto 内部 Setting → 协议（applied 全部 enabled=true）。
func settingsToProto(cfg []snippet.Setting) []*ombv1.SnippetSetting {
	out := make([]*ombv1.SnippetSetting, 0, len(cfg))
	for _, s := range cfg {
		out = append(out, &ombv1.SnippetSetting{
			Kind: snippet.KindToProto(s.Kind), Enabled: true,
			P1: s.P1, P2: s.P2, S1: s.S1,
		})
	}
	return out
}

// snippetSourceViews catalog 全量官方模块的可查看源码（教材视角，
// 默认参数渲染；每次请求现生成，与组合执行同一定稿）。
func snippetSourceViews() []*ombv1.SnippetSourceView {
	mods := snippet.Catalog()
	out := make([]*ombv1.SnippetSourceView, 0, len(mods))
	for _, mod := range mods {
		out = append(out, &ombv1.SnippetSourceView{
			Kind:      snippet.KindToProto(mod.Kind),
			Title:     mod.Title,
			Source:    mod.Source(mod.Default), // 默认参数下的定稿源码（教材视角）
			DefaultP1: mod.Default.P1,
			DefaultS1: mod.Default.S1,
		})
	}
	return out
}
