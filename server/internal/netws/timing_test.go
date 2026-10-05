package netws

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 心跳/时序参数漂移对拍（审计 X-5）：单一权威源为生成枚举 ombv1.TransportTiming
// （protocol/proto/omb.proto 定义；handler.go 与客户端 packages/protocol/src/ws.ts
// 均从生成代码取值，不再手写时序字面量）。本测试四向互钉：
//  1. Go 运行时常量 == 期望数值（权威源被误删/误改时兜底）
//  2. 生成代码 == 权威源 .proto 文本（改 proto 忘跑 buf generate 时失败）
//  3. 权威源数值 == 期望数值（只改生成代码不改 proto 时失败）
//  4. 双侧实现源码无手写心跳/帧字节字面量（手写回归被拦截）
//
// 帧字节另有 TestFrameBytesPinned（handler_test.go）与 TS golden.test.ts 对拍；
// 互钉注释必须随本测试同步更新。
func TestTransportTimingPinned(t *testing.T) {
	// 1. 运行时常量逐位钉住：重构前后运行时行为逐位相同。
	for _, w := range []struct {
		name string
		got  time.Duration
		ms   int64
	}{
		{"pingInterval", pingInterval, 2000},
		{"writeTimeout", writeTimeout, 2000},
		{"serverReadTimeout", serverReadTimeout, 10000},
	} {
		if w.got != time.Duration(w.ms)*time.Millisecond {
			t.Errorf("%s = %v, want %dms", w.name, w.got, w.ms)
		}
	}
	if framePing != 0x00 || framePong != 0x01 || frameUp != 0x02 || frameDown != 0x03 {
		t.Error("frame bytes drifted")
	}
	if maxFrameBytes != 65536 {
		t.Errorf("maxFrameBytes = %d, want 65536", maxFrameBytes)
	}

	// 2+3. 生成代码与权威源 .proto 文本互拍：解析每个枚举值的完整名与数值，
	// 任一侧缺失或漂移即失败。
	protoRaw, err := os.ReadFile("../../../protocol/proto/omb.proto")
	if err != nil {
		t.Skipf("proto source not readable: %v", err)
	}
	genRaw, err := os.ReadFile("../protocol/gen/proto/omb.pb.go")
	if err != nil {
		t.Skipf("generated code not readable: %v", err)
	}
	protoSrc, genSrc := string(protoRaw), string(genRaw)

	specs := []struct {
		short string // 枚举值短名（枚举内唯一）
		val   int64
	}{
		{"FRAME_PING", 0x00},
		{"FRAME_PONG", 0x01},
		{"FRAME_UP", 0x02},
		{"FRAME_DOWN", 0x03},
		{"CONNECT_TIMEOUT_MS", 8000},
		{"PING_INTERVAL_MS", 2000},
		{"LIVENESS_TIMEOUT_MS", 8000},
		{"LIVENESS_CHECK_MS", 1000},
		{"SERVER_READ_TIMEOUT_MS", 10000},
		{"SERVER_WRITE_TIMEOUT_MS", 2000},
		{"MAX_FRAME_BYTES", 65536},
	}

	// TransportTiming 枚举体（首个 { 到配对 }），避免匹配其他枚举的同名值。
	enumStart := strings.Index(protoSrc, "enum TransportTiming")
	if enumStart < 0 {
		t.Fatal("TransportTiming enum missing from omb.proto")
	}
	open := strings.Index(protoSrc[enumStart:], "{")
	if open < 0 {
		t.Fatal("TransportTiming enum body missing")
	}
	depth, bodyEnd := 0, -1
	for i := enumStart + open; i < len(protoSrc); i++ {
		switch protoSrc[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				bodyEnd = i
			}
		}
		if bodyEnd >= 0 {
			break
		}
	}
	if bodyEnd < 0 {
		t.Fatal("TransportTiming enum body unterminated")
	}
	enumBody := protoSrc[enumStart+open : bodyEnd]

	for _, s := range specs {
		// 权威源："<短名> = <数值>;"（本仓库枚举值单行风格）。
		protoNeedle := s.short + " = " + strconv.FormatInt(s.val, 10) + ";"
		if !strings.Contains(enumBody, protoNeedle) {
			t.Errorf("omb.proto TransportTiming missing %q", protoNeedle)
		}
		// 生成代码："<完整名>…<类型> = <数值>"（protoc-gen-go const 声明，
		// 列对齐导致名与类型间可能有多个空格/制表符，用正则容忍）。
		genRe := regexp.MustCompile(`TransportTiming_` + s.short + `\s+TransportTiming\s*=\s*` + strconv.FormatInt(s.val, 10) + `\b`)
		if !genRe.MatchString(genSrc) {
			t.Errorf("generated omb.pb.go missing TransportTiming_%s = %d (re-run buf generate)", s.short, s.val)
		}
	}

	// 4. 手写时序字面量回归拦截：双侧实现源码若再次手抄心跳数值或帧字节
	// （而非从 TransportTiming 取值），在此失败。仅扫代码，跳过 // 注释。
	goSrc := mustRead(t, "handler.go")
	tsSrc := mustRead(t, "../../../packages/protocol/src/ws.ts")
	goCode := stripLineComments(t, goSrc, "//")
	tsCode := stripLineComments(t, tsSrc, "//")
	// Go：时长手写字面量（如 2*time.Second / 8000*time.Millisecond）。
	if regexp.MustCompile(`\d+\s*\*\s*time\.(Second|Millisecond|Minute)`).MatchString(goCode) {
		t.Error("handler.go re-introduced a handwritten time.Duration literal; derive from ombv1.TransportTiming")
	}
	// Go/TS：帧字节手写（帧首字节只允许出现在权威源与测试）。
	for _, b := range []string{"0x00", "0x01", "0x02", "0x03"} {
		if strings.Contains(goCode, b) {
			t.Errorf("handler.go re-introduced handwritten frame byte %s; use ombv1.TransportTiming", b)
		}
		if strings.Contains(tsCode, b) {
			t.Errorf("ws.ts re-introduced handwritten frame byte %s; use TransportTiming", b)
		}
	}
	// TS：心跳常量手写数字（如 const PING_INTERVAL_MS = 2000）。
	if regexp.MustCompile(`(?m)^\s*const\s+\w*(TIMEOUT|INTERVAL|PING|PONG|LIVENESS)\w*\s*=\s*\d`).MatchString(tsCode) {
		t.Error("ws.ts re-introduced a handwritten heartbeat numeric literal; derive from TransportTiming")
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("source not readable: %v", err)
		return ""
	}
	return string(raw)
}

// stripLineComments 去掉以 marker 开头的注释行，避免文档里的示例数值误报。
func stripLineComments(t *testing.T, src, marker string) string {
	t.Helper()
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), marker) {
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}
