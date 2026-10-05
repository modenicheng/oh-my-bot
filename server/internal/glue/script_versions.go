package glue

import (
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// 脚本版本链（TODO：AI 代码直接填入编辑器 + 房间作用域版本回退）。
//
// 模型：RoomConn.scriptVersions[playerID] 保存该玩家的有界版本链（房间身份
// 状态，跨局保留：warmup→running、Restart 不清；玩家显式离开才清理——与
// scriptSource/snippets/assist 同生命周期）。每个成功落地的版本（手动提交 /
// AI 改码 / 版本回退）追加一条 {id, rev, origin, wallMs, source}；当前指针
// current 始终指向链尾（最新写入即当前——服务器权威，客户端只消费）。
//
// 下发：版本写入后立即向该玩家当前绑定会话定向推送全量 EvScriptVersions
// （链有界 ≤32 条，全量重推足够小）；重连/接管 bootstrap 时补发。owner-only：
// 其他玩家与观战者结构性收不到（只在 owner 会话上发送，不广播）。
//
// OCC：AI 改码仍走 rt.LoadIfRev（版本链只是记录视图，不引入第二把锁）；
// 回退走显式 version_id 定位，天然幂等安全（回退失败保旧）。

// maxScriptVersions 每玩家版本链上限：超出后淘汰最旧版本（含其源码）。
// 32 条 × 平均 8 KiB 源码 ≈ 256 KiB/玩家 上界，房间 64 人时 <16 MiB。
const maxScriptVersions = 32

// scriptVersion 单条版本记录（房间身份状态，不可变）。
// runtimeSource：服务器执行用的 JavaScript（手动 JS = 编辑器原文；手动 TS =
// 浏览器编译产物；AI 产出恒为 JavaScript）。回退用它重新装载运行时。
// editorSource + language：owner 客户端恢复编辑器用（TS 版 = TS 原文）。
type scriptVersion struct {
	id            uint32
	rev           uint32 // 该版本装载后的 runtime rev（回显用；与当前 match 的 rev 无跨局对应关系）
	origin        ombv1.ScriptOrigin
	wallMs        int64
	runtimeSource string
	editorSource  string
	language      ombv1.ScriptLanguage
}

// scriptVersionChain 单玩家版本链：append-only + 当前指针（恒为链尾）+ 房间内
// 单调 id。淘汰从头部进行（最旧版本先被遗忘）。
type scriptVersionChain struct {
	versions []scriptVersion
	current  uint32 // 当前生效版本 id（0 = 无已记录版本）
	nextID   uint32
}

// append 记录一个成功落地的版本并前移当前指针；超出上限淘汰最旧版本。
// 返回新版本 id。调用方持 rc.mu。
func (c *scriptVersionChain) append(rev uint32, origin ombv1.ScriptOrigin, wallMs int64, runtimeSource, editorSource string, language ombv1.ScriptLanguage) uint32 {
	if c.nextID == 0 {
		c.nextID = 1
	}
	id := c.nextID
	c.nextID++
	c.versions = append(c.versions, scriptVersion{id: id, rev: rev, origin: origin, wallMs: wallMs,
		runtimeSource: runtimeSource, editorSource: editorSource, language: language})
	if len(c.versions) > maxScriptVersions {
		c.versions = c.versions[len(c.versions)-maxScriptVersions:]
	}
	c.current = id
	return id
}

// byID 查找版本记录（淘汰后旧 id 不再可见——回退请求返回 not found）。
func (c *scriptVersionChain) byID(id uint32) (scriptVersion, bool) {
	for _, v := range c.versions {
		if v.id == id {
			return v, true
		}
	}
	return scriptVersion{}, false
}

// toProto 转协议视图（升序旧 → 新）。source 为编辑器恢复源码；language 仅在
// 非 JS 时携带（JS 走缺省，旧客户端零成本兼容）。
func (c *scriptVersionChain) toProto() *ombv1.EvScriptVersions {
	out := &ombv1.EvScriptVersions{CurrentId: c.current, Versions: make([]*ombv1.EvScriptVersion, 0, len(c.versions))}
	for _, v := range c.versions {
		ev := &ombv1.EvScriptVersion{
			Id: v.id, ScriptRev: v.rev, Origin: v.origin, WallMs: uint64(v.wallMs), Source: v.editorSource,
		}
		if v.language != ombv1.ScriptLanguage_SCRIPT_LANGUAGE_JS {
			lang := v.language
			ev.Language = &lang
		}
		out.Versions = append(out.Versions, ev)
	}
	return out
}

// nowWallMs 注入点（测试可替换为确定值）。
var nowWallMs = func() int64 { return time.Now().UnixMilli() }

// recordScriptVersionLocked 记录一个成功落地的版本（不推送——调用方先发
// 各自的回执消息，再显式 pushScriptVersionsLocked，保证客户端看到
// 「回执 → 版本链快照」的固定顺序）。runtimeSource = 服务器执行的 JS；
// editorSource/language = owner 编辑器恢复语义。
// 调用方持 rc.mu。
func (m *Match) recordScriptVersionLocked(pid uint64, rev uint32, origin ombv1.ScriptOrigin, runtimeSource, editorSource string, language ombv1.ScriptLanguage) uint32 {
	chain := m.rc.scriptVersions[pid]
	if chain == nil {
		chain = &scriptVersionChain{}
		m.rc.scriptVersions[pid] = chain
	}
	return chain.append(rev, origin, nowWallMs(), runtimeSource, editorSource, language)
}

// pushScriptVersionsLocked 定向下发该玩家版本链快照（owner-only，不广播）。
func (m *Match) pushScriptVersionsLocked(pid uint64) {
	chain := m.rc.scriptVersions[pid]
	if chain == nil {
		return
	}
	sess := m.rc.sessions[pid]
	if sess == nil {
		return
	}
	sess.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptVersions{ScriptVersions: chain.toProto()},
	}}})
}

// sendScriptVersionsState bootstrap/重连补发（无 match 时也可用：版本链属
// 房间身份，不依赖对局）。
func (rc *RoomConn) sendScriptVersionsStateLocked(pid uint64) {
	sess := rc.sessions[pid]
	chain := rc.scriptVersions[pid]
	if sess == nil || chain == nil {
		return
	}
	sess.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptVersions{ScriptVersions: chain.toProto()},
	}}})
}

// rollbackScriptLocked 处理版本回退：定位版本 → 以当前 snippet 配置装载该版本
// 的 runtimeSource（服务器执行 JS；手动 TS 版 = 存库的编译产物）→ 成功则记录
// 回退版本（新 id，来源 ROLLBACK，编辑器语义同回退目标）并更新房间 scriptSource；
// 失败保旧（现役脚本与当前版本指针均不动）。回执携带编辑器恢复源码 + 语言。
// 仅房间玩家可达（withRoom 结构性隔离观战者）；版本链按玩家隔离，他人版本
// id 天然查不到（not found）。
func (m *Match) rollbackScriptLocked(pid uint64, versionID uint32) {
	sess := m.rc.sessions[pid]
	if sess == nil {
		return
	}
	chain := m.rc.scriptVersions[pid]
	if chain == nil {
		m.sendRollbackResultLocked(sess, false, "版本不存在或已被淘汰（历史仅保留最近 32 个版本）", 0, 0, "", nil)
		return
	}
	target, ok := chain.byID(versionID)
	if !ok {
		m.sendRollbackResultLocked(sess, false, "版本不存在或已被淘汰（历史仅保留最近 32 个版本）", 0, 0, "", nil)
		return
	}
	if _, inMatch := m.robotOf[pid]; !inMatch {
		m.sendRollbackResultLocked(sess, false, "当前不在对局中，无法回退", chain.current, 0, "", nil)
		return
	}
	rollbackOk, rollbackErrMsg, newRev := m.submitScriptLocked(pid, target.runtimeSource)
	if !rollbackOk {
		// 编译失败保旧：现役脚本、当前版本指针、编辑器均不动。
		m.sendRollbackResultLocked(sess, false, "回退目标编译失败，已保留当前脚本："+rollbackErrMsg, chain.current, m.currentScriptRevLocked(pid), "", nil)
		return
	}
	newVersionID := m.recordScriptVersionLocked(pid, newRev, ombv1.ScriptOrigin_ORIGIN_ROLLBACK, target.runtimeSource, target.editorSource, target.language)
	m.sendRollbackResultLocked(sess, true, "", newVersionID, newRev, target.editorSource, &target.language)
	m.pushScriptVersionsLocked(pid)
}

func (m *Match) sendRollbackResultLocked(sess *Session, ok bool, errMsg string, versionID, rev uint32, source string, language *ombv1.ScriptLanguage) {
	sess.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
		Kind: &ombv1.ServerEvent_ScriptRollbackResult{ScriptRollbackResult: &ombv1.EvScriptRollbackResult{
			Ok: ok, Error: errMsg, VersionId: versionID, ScriptRev: rev, Source: source, Language: language,
		}},
	}}})
}

// currentScriptRevLocked 当前生效 runtime 的 rev（无 runtime = 0）。
func (m *Match) currentScriptRevLocked(pid uint64) uint32 {
	rid, ok := m.robotOf[pid]
	if !ok {
		return 0
	}
	if rt := m.scriptPool.RuntimeOf(rid); rt != nil {
		return rt.Rev()
	}
	return 0
}
