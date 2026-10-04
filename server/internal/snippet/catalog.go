// Package snippet 官方驾驶辅助目录（v0.3 §9-2）。
//
// Snippet 本质是「可查看源码的官方 Bot Script 模块」：每条是一段定稿 JS，
// 只使用公开 bot API（与玩家脚本同一契约），经 combiner 与玩家源码组合成
// 一个合法 tick 在同一 GojaRuntime/RunPool 内执行——不旁路 sim、不旁路仲裁。
//
// 本包是唯一 catalog 事实源：kind 枚举、参数校验、默认值、官方源码生成。
// glue 只做装配；协议层只做透传。
package snippet

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// Kind 与 ombv1.SnippetKind 一一对应（本包不依赖 proto 枚举名以保持可测）。
type Kind int

const (
	AutoAim Kind = 1 // 自动瞄准（无参数，纯直瞄）
	// 2/3 已移除：AutoFire 自动开火、AutoPickup 有限半径自动拾取。
	EmergencyShield Kind = 4 // 紧急护盾（HP 阈值 0..100）
	DangerAvoid     Kind = 5 // 危险规避（威胁半径 m）
	Patrol          Kind = 6 // 简单巡逻（路径点）
	GlobalCore      Kind = 7 // 全局 Core 拾取（无参数）
	LowHpHealthPack Kind = 8 // 低血量自动拾取血包（HP 阈值 1..100）
)

// 参数范围（设计文档 §9：每条 0–2 参数；范围校验 + 稳定默认值）。
// 已移除模块：AutoFire（自动开火，职责并入玩家/Bot Script）与
// AutoPickup（有限半径自动拾取，被 GlobalCore 全局拾取取代）；
// kind 编号 2/3 永不复用（协议 additive 原则）。
const (
	emergencyShieldMin     = 0.0
	emergencyShieldMax     = 100.0
	emergencyShieldDefault = 30.0
	dangerAvoidRadiusMin   = 2.0
	dangerAvoidRadiusMax   = 20.0
	dangerAvoidRadiusDflt  = 8.0
	lowHpHealthPackMin     = 1.0
	lowHpHealthPackMax     = 100.0
	lowHpHealthPackDefault = 45.0
	patrolMaxWaypoints     = 8
	patrolArenaRadius      = 80.0 // 地图半径（±80 坐标域）
	patrolDefaultS1        = "30,0;0,30;-30,0;0,-30"
)

// Setting 一条已验证的 Snippet 配置（组合执行参数）。
type Setting struct {
	Kind   Kind
	P1, P2 float64
	S1     string
}

// Module 一条官方 Snippet 的 catalog 条目。
type Module struct {
	Kind    Kind
	Title   string // 展示名（协议下发）
	Default Setting
	// Validate 校验参数并返回规范化后的 Setting（越界/非法 → error）。
	Validate func(s Setting) (Setting, error)
	// Source 生成官方模块 JS 源码（cfg 已规范化；字符串为模块体，
	// 定义 `function snippetTick(api)`，由 combiner 包装执行）。
	Source func(cfg Setting) string
}

// gofmt-safe 常量：官方源码模板的共享片段。

// catalog 是唯一事实源；顺序即组合执行顺序（确定性）。
var catalog = []Module{
	{
		Kind:    AutoAim,
		Title:   "自动瞄准",
		Default: Setting{Kind: AutoAim},
		Validate: func(s Setting) (Setting, error) {
			s.Kind = AutoAim
			// 无参数模块：清空全部参数位，保持单一规范表示。
			s.P1, s.P2, s.S1 = 0, 0, ""
			return s, nil
		},
		Source: autoAimSource,
	},
	{
		Kind:    EmergencyShield,
		Title:   "紧急护盾",
		Default: Setting{Kind: EmergencyShield, P1: emergencyShieldDefault},
		Validate: func(s Setting) (Setting, error) {
			s.Kind = EmergencyShield
			if !inRange(s.P1, emergencyShieldMin, emergencyShieldMax) {
				return s, fmt.Errorf("emergency_shield: hp threshold must be %.0f..%.0f", emergencyShieldMin, emergencyShieldMax)
			}
			s.P1 = math.Round(s.P1)
			s.P2, s.S1 = 0, ""
			return s, nil
		},
		Source: emergencyShieldSource,
	},
	{
		Kind:    DangerAvoid,
		Title:   "危险规避",
		Default: Setting{Kind: DangerAvoid, P1: dangerAvoidRadiusDflt},
		Validate: func(s Setting) (Setting, error) {
			s.Kind = DangerAvoid
			if !inRange(s.P1, dangerAvoidRadiusMin, dangerAvoidRadiusMax) {
				return s, fmt.Errorf("danger_avoid: radius must be %.0f..%.0f m", dangerAvoidRadiusMin, dangerAvoidRadiusMax)
			}
			s.P1 = math.Round(s.P1*10) / 10
			s.P2, s.S1 = 0, ""
			return s, nil
		},
		Source: dangerAvoidSource,
	},
	{
		Kind:    Patrol,
		Title:   "简单巡逻",
		Default: Setting{Kind: Patrol, S1: patrolDefaultS1},
		Validate: func(s Setting) (Setting, error) {
			s.Kind = Patrol
			pts, err := ParseWaypoints(s.S1)
			if err != nil {
				return s, err
			}
			if len(pts) == 0 {
				// 空路径点 = 用默认方形巡逻圈。
				s.S1 = patrolDefaultS1
			} else {
				s.S1 = FormatWaypoints(pts) // 规范化回写（去空白、定精度）
			}
			s.P1, s.P2 = 0, 0
			return s, nil
		},
		Source: patrolSource,
	},
	{
		Kind:    GlobalCore,
		Title:   "全局 Core 拾取",
		Default: Setting{Kind: GlobalCore},
		Validate: func(s Setting) (Setting, error) {
			s.Kind = GlobalCore
			// 无参数模块：忽略并清空所有参数位，保持单一规范表示。
			s.P1, s.P2, s.S1 = 0, 0, ""
			return s, nil
		},
		Source: globalCoreSource,
	},
	{
		Kind:    LowHpHealthPack,
		Title:   "低血量自动拾取血包",
		Default: Setting{Kind: LowHpHealthPack, P1: lowHpHealthPackDefault},
		Validate: func(s Setting) (Setting, error) {
			s.Kind = LowHpHealthPack
			if !inRange(s.P1, lowHpHealthPackMin, lowHpHealthPackMax) || math.Trunc(s.P1) != s.P1 {
				return s, fmt.Errorf("low_hp_health_pack: hp threshold must be an integer %.0f..%.0f", lowHpHealthPackMin, lowHpHealthPackMax)
			}
			s.P2, s.S1 = 0, ""
			return s, nil
		},
		Source: lowHpHealthPackSource,
	},
}

func inRange(v, min, max float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= min && v <= max
}

// ParseWaypoints 解析 "x,y;x,y"（最多 8 点，坐标域 ±80）。空串返回空切片。
func ParseWaypoints(s string) ([][2]float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ";")
	if len(parts) > patrolMaxWaypoints {
		return nil, fmt.Errorf("patrol: at most %d waypoints", patrolMaxWaypoints)
	}
	out := make([][2]float64, 0, len(parts))
	for i, p := range parts {
		xy := strings.Split(strings.TrimSpace(p), ",")
		if len(xy) != 2 {
			return nil, fmt.Errorf("patrol: waypoint %d must be x,y", i+1)
		}
		x, err := strconv.ParseFloat(strings.TrimSpace(xy[0]), 64)
		if err != nil {
			return nil, fmt.Errorf("patrol: waypoint %d x: %w", i+1, err)
		}
		y, err := strconv.ParseFloat(strings.TrimSpace(xy[1]), 64)
		if err != nil {
			return nil, fmt.Errorf("patrol: waypoint %d y: %w", i+1, err)
		}
		if !inRange(x, -patrolArenaRadius, patrolArenaRadius) || !inRange(y, -patrolArenaRadius, patrolArenaRadius) {
			return nil, fmt.Errorf("patrol: waypoint %d outside ±%.0fm arena", i+1, patrolArenaRadius)
		}
		out = append(out, [2]float64{x, y})
	}
	return out, nil
}

// FormatWaypoints 规范化序列化（与 ParseWaypoints 互逆）。
func FormatWaypoints(pts [][2]float64) string {
	parts := make([]string, 0, len(pts))
	for _, p := range pts {
		parts = append(parts, fmt.Sprintf("%g,%g", p[0], p[1]))
	}
	return strings.Join(parts, ";")
}

// ModuleOf 按 kind 查 catalog（未知 kind 返回 nil）。
func ModuleOf(k Kind) *Module {
	for i := range catalog {
		if catalog[i].Kind == k {
			return &catalog[i]
		}
	}
	return nil
}

// Catalog 返回全部官方模块（确定性顺序）。
func Catalog() []Module { return append([]Module{}, catalog...) }

// KindFromProto 协议枚举 → 本包 Kind。
func KindFromProto(k ombv1.SnippetKind) Kind { return Kind(k) }

// KindToProto 本包 Kind → 协议枚举。
func KindToProto(k Kind) ombv1.SnippetKind { return ombv1.SnippetKind(k) }
