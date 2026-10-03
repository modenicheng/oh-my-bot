package ai

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ServerConfig 服务端运行配置（config.yaml 非秘密段 + .env 秘密段）。
//
// 取值优先级：进程环境变量 > .env > config.yaml > 默认值。
// config.yaml 路径解析：可执行文件同级目录 → 进程工作目录，先命中先用。
type ServerConfig struct {
	AI     AIConfig
	Quota  QuotaConfig
	GC     GCConfig
	APIKey string // DeepSeek key（.env/环境变量 DEEPSEEK_API_KEY；不写日志）
}

// GCConfig Go 运行时垃圾回收参数（config.yaml gc.* 段）。
//
// 背景（2026-10 bit-333 perf 剖析）：64 脚本 60Hz 对局每帧产生 ~9MB
// 短命 goja 对象，默认 GOGC=100 下 GC 协助吞掉 ~40% 帧预算（8 worker
// 只剩 4.3x 有效并行）。GOGC=400 实测帧时 -34%（7.5ms→4.96ms）、
// script deferred 1.4%→0%。这些对象是 tick 级垃圾，加大触发间隔
// 只影响峰值堆（几百 MB 量级），不影响稳态内存。
type GCConfig struct {
	// Percent 等价 GOGC：触发下次 GC 的堆增长百分比。0 = 不调整
	//（沿用进程默认 100 或外部 GOGC 环境变量）。
	Percent int
	// MemoryLimit 等价 GOMEMLIMIT（如 "512MiB"）。空 = 不设置。
	// 与 Percent 配合使用可在拿到 GC 收益的同时给内存兜底。
	MemoryLimit string
}

const (
	// GCPercentDefault 生产推荐值（见 GCConfig 文档）。
	GCPercentDefault = 400
	// GCPercentMax 防御上限：>2000 后收益趋平、风险（堆溢出 OOM）上升。
	GCPercentMax = 2000
)

// AIConfig AI 通道参数（config.yaml ai.* 段）。
type AIConfig struct {
	Enabled  bool          // 总开关；false 或缺 key 时安全禁用（不装配 provider）
	Model    string        // 默认 deepseek-chat
	Endpoint string        // 默认 https://api.deepseek.com/chat/completions
	Timeout  time.Duration // HTTP 客户端超时（默认 30s）
}

// EnvKey DEEPSEEK_API_KEY。
const EnvKey = DeepSeekKeyEnv

// LoadServerConfig 解析配置：dir 下的 config.yaml 与 .env（dir 为空时
// 自动探测：可执行文件目录 → cwd）。解析失败返回错误——运营显式修复，
// 不静默降级。key 缺失不是错误：返回零值 key，由调用方决定禁用。
func LoadServerConfig(dir string) (ServerConfig, error) {
	if dir == "" {
		if configured := strings.TrimSpace(os.Getenv("OMB_CONFIG_DIR")); configured != "" {
			dir = configured
		} else {
			dir = resolveConfigDir()
		}
	}
	cfg := ServerConfig{
		AI: AIConfig{
			Model:    DeepSeekDefaultModel,
			Endpoint: DeepSeekDefaultEndpoint,
			Timeout:  DeepSeekDefaultTimeout,
		},
		Quota: DefaultQuotaConfig(),
	}

	if raw, err := os.ReadFile(filepath.Join(dir, "config.yaml")); err == nil {
		kv, err := parseSimpleYAML(string(raw))
		if err != nil {
			return ServerConfig{}, fmt.Errorf("config.yaml: %w", err)
		}
		cfg.applyYAML(kv)
	} else if !os.IsNotExist(err) {
		return ServerConfig{}, fmt.Errorf("config.yaml: %w", err)
	}

	if raw, err := os.ReadFile(filepath.Join(dir, ".env")); err == nil {
		kv, err := parseDotEnv(string(raw))
		if err != nil {
			return ServerConfig{}, fmt.Errorf(".env: %w", err)
		}
		// .env 优先于 config.yaml（但低于进程环境）。
		cfg.APIKey = firstNonEmpty(kv[EnvKey], cfg.APIKey)
		cfg.AI.Enabled = parseBoolKV(kv, "AI_ENABLED", cfg.AI.Enabled)
		if v, ok := kv["AI_MODEL"]; ok {
			cfg.AI.Model = v
		}
		if v, ok := kv["AI_ENDPOINT"]; ok {
			cfg.AI.Endpoint = v
		}
		if v, err := parseSecondsKV(kv, "AI_TIMEOUT_SECONDS", 0); err == nil && v > 0 {
			cfg.AI.Timeout = v
		}
	} else if !os.IsNotExist(err) {
		return ServerConfig{}, fmt.Errorf(".env: %w", err)
	}

	// 进程环境最高优先。
	if v := os.Getenv(EnvKey); v != "" {
		cfg.APIKey = v
	}
	if v := os.Getenv("AI_ENABLED"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.AI.Enabled = b
		}
	}
	if v := os.Getenv("AI_MODEL"); v != "" {
		cfg.AI.Model = v
	}
	if v := os.Getenv("AI_ENDPOINT"); v != "" {
		cfg.AI.Endpoint = v
	}
	if v := os.Getenv("AI_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
			cfg.AI.Timeout = time.Duration(n * float64(time.Second))
		}
	}
	if n, ok := envUint("QUOTA_ROUNDS"); ok {
		cfg.Quota.PlayerRounds = uint32(n)
	}
	if n, ok := envUint("QUOTA_PLAYER_TOKENS"); ok {
		cfg.Quota.PlayerTokens = uint32(n)
	}
	if n, ok := envUint("QUOTA_GLOBAL_TOKENS"); ok {
		cfg.Quota.GlobalTokens = uint32(n)
	}
	if n, ok := envUint("QUOTA_MAX_CONCURRENCY"); ok {
		cfg.Quota.MaxConcurrency = int(n)
	}
	if n, ok := envUint("OMB_GC_PERCENT"); ok {
		cfg.GC.Percent = int(n)
	}
	if v := os.Getenv("OMB_GC_MEMORY_LIMIT"); v != "" {
		cfg.GC.MemoryLimit = v
	}

	if cfg.AI.Model == "" {
		cfg.AI.Model = DeepSeekDefaultModel
	}
	if cfg.AI.Endpoint == "" {
		cfg.AI.Endpoint = DeepSeekDefaultEndpoint
	}
	if cfg.AI.Timeout <= 0 {
		cfg.AI.Timeout = DeepSeekDefaultTimeout
	}
	return cfg, nil
}

// applyYAML 应用 config.yaml 键值（ai.* 与 quota.* 段；扁平键名）。
func (c *ServerConfig) applyYAML(kv map[string]string) {
	c.AI.Enabled = parseBoolKV(kv, "AI_ENABLED", c.AI.Enabled)
	if v := firstNonEmpty(kv["AI_MODEL"], kv["AI.MODEL"]); v != "" {
		c.AI.Model = v
	}
	if v := firstNonEmpty(kv["AI_ENDPOINT"], kv["AI.ENDPOINT"]); v != "" {
		c.AI.Endpoint = v
	}
	if v, err := parseSecondsKV(kv, "AI_TIMEOUT_SECONDS", 0); err == nil && v > 0 {
		c.AI.Timeout = v
	} else if v, err := parseSecondsKV(kv, "AI_TIMEOUT", 0); err == nil && v > 0 {
		c.AI.Timeout = v
	}
	if n, ok := yamlUint(kv, "QUOTA_ROUNDS", "QUOTA.PLAYER_ROUNDS"); ok {
		c.Quota.PlayerRounds = uint32(n)
	}
	if n, ok := yamlUint(kv, "QUOTA_PLAYER_TOKENS", "QUOTA.PLAYER_TOKENS"); ok {
		c.Quota.PlayerTokens = uint32(n)
	}
	if n, ok := yamlUint(kv, "QUOTA_GLOBAL_TOKENS", "QUOTA.GLOBAL_TOKENS"); ok {
		c.Quota.GlobalTokens = uint32(n)
	}
	if n, ok := yamlUint(kv, "QUOTA_MAX_CONCURRENCY", "QUOTA.MAX_CONCURRENCY"); ok {
		c.Quota.MaxConcurrency = int(n)
	}
	if n, ok := yamlUint(kv, "GC_PERCENT", "GC.PERCENT"); ok {
		c.GC.Percent = int(n)
	}
	if v := firstNonEmpty(kv["GC_MEMORY_LIMIT"], kv["GC.MEMORY_LIMIT"]); v != "" {
		c.GC.MemoryLimit = v
	}
}

// resolveConfigDir 配置目录探测：可执行文件目录 → cwd。
// go test 下可执行文件在临时目录，两个位置都无配置文件时自然落到
// cwd（等价于找不到配置——非错误，全部默认值）。
func resolveConfigDir() string {
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if fileExists(filepath.Join(dir, "config.yaml")) || fileExists(filepath.Join(dir, ".env")) {
			return dir
		}
	}
	if wd, err := os.Getwd(); err == nil {
		if fileExists(filepath.Join(wd, "config.yaml")) || fileExists(filepath.Join(wd, ".env")) {
			return wd
		}
	}
	// 都没有：返回 exe 目录（后续 ReadFile 报 NotExist，走默认值）。
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	return "."
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// parseSimpleYAML 解析本服务支持的 yaml 子集：两层缩进嵌套映射 → 扁平
// "PARENT_CHILD" 键。支持 `key: value`、`#` 注释、引号标量。列表/锚点/
// 多文档等超集语法返回错误（运营配置应显式修复而非静默忽略）。
func parseSimpleYAML(raw string) (map[string]string, error) {
	out := map[string]string{}
	var parent string
	for i, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line = strings.TrimRight(line, " \t")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		line = strings.TrimSpace(line)
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("line %d: expected `key: value`", i+1)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if value == "" {
			// 无值：视为进入子段（仅一层嵌套）。key 带点时视为叶子段名。
			if indent == 0 {
				parent = key
			} else {
				parent = ""
			}
			continue
		}
		if i := strings.Index(value, " #"); i >= 0 && !strings.HasPrefix(value, "\"") && !strings.HasPrefix(value, "'") {
			value = strings.TrimSpace(value[:i])
		}
		value = unquote(value)
		full := strings.ToUpper(strings.ReplaceAll(key, ".", "_"))
		if parent != "" && indent > 0 {
			full = strings.ToUpper(strings.ReplaceAll(parent+"_"+key, ".", "_"))
		}
		out[full] = value
	}
	return out, nil
}

// parseDotEnv 解析 .env：KEY=VALUE 行，支持 export 前缀、引号值、# 注释。
func parseDotEnv(raw string) (map[string]string, error) {
	out := map[string]string{}
	for i, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected KEY=VALUE", i+1)
		}
		key = strings.ToUpper(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if i := strings.Index(value, " #"); i >= 0 && !strings.HasPrefix(value, "\"") && !strings.HasPrefix(value, "'") {
			value = strings.TrimSpace(value[:i])
		}
		out[key] = unquote(value)
	}
	return out, nil
}

func unquote(v string) string {
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}

func parseBoolKV(kv map[string]string, key string, fallback bool) bool {
	if v, ok := kv[key]; ok {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}

func parseSecondsKV(kv map[string]string, key string, fallback time.Duration) (time.Duration, error) {
	v, ok := kv[key]
	if !ok || v == "" {
		return fallback, nil
	}
	// 纯数字 = 秒；也接受 "30s" 这类 Go duration 字面量。
	if n, err := strconv.ParseFloat(v, 64); err == nil {
		return time.Duration(n * float64(time.Second)), nil
	}
	return time.ParseDuration(v)
}

func yamlUint(kv map[string]string, keys ...string) (uint64, bool) {
	for _, k := range keys {
		if v, ok := kv[k]; ok {
			if n, err := strconv.ParseUint(v, 10, 64); err == nil {
				return n, true
			}
		}
	}
	return 0, false
}

func envUint(key string) (uint64, bool) {
	v := os.Getenv(key)
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	return n, err == nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
