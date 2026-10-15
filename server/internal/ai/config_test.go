package ai

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeConfig(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadServerConfigDefaults(t *testing.T) {
	dir := t.TempDir()
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Enabled || cfg.AI.Model != DeepSeekDefaultModel || cfg.AI.Endpoint != DeepSeekDefaultEndpoint {
		t.Fatalf("ai defaults = %+v", cfg.AI)
	}
	if cfg.AI.Timeout != DeepSeekDefaultTimeout {
		t.Fatalf("timeout = %v", cfg.AI.Timeout)
	}
	if cfg.Quota != DefaultQuotaConfig() {
		t.Fatalf("quota defaults = %+v", cfg.Quota)
	}
	if cfg.APIKey != "" {
		t.Fatal("key must default empty")
	}
}

func TestLoadServerConfigGCDefaultAndOverrides(t *testing.T) {
	// 裸加载即压测口径（ADR-0015），部署侧无需再设 OMB_GC_PERCENT。
	t.Setenv("OMB_GC_PERCENT", "")
	bare, err := LoadServerConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if bare.GC.Percent != GCPercentDefault {
		t.Fatalf("bare gc.percent = %d, want in-code default %d", bare.GC.Percent, GCPercentDefault)
	}

	// 进程环境显式值覆盖默认。
	t.Setenv("OMB_GC_PERCENT", "600")
	envCfg, err := LoadServerConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if envCfg.GC.Percent != 600 {
		t.Fatalf("env override gc.percent = %d, want 600", envCfg.GC.Percent)
	}

	// yaml 显式值同样覆盖；显式 0 = 沿用进程默认/外部 GOGC（逃生口）。
	t.Setenv("OMB_GC_PERCENT", "")
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{"config.yaml": "gc:\n  percent: 150\n"})
	yamlCfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if yamlCfg.GC.Percent != 150 {
		t.Fatalf("yaml override gc.percent = %d, want 150", yamlCfg.GC.Percent)
	}
	t.Setenv("OMB_GC_PERCENT", "0")
	zeroCfg, err := LoadServerConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if zeroCfg.GC.Percent != 0 {
		t.Fatalf("explicit zero gc.percent = %d, want 0 (process default)", zeroCfg.GC.Percent)
	}
}

func TestLoadServerConfigYAML(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{
		"config.yaml": `# 运营配置
ai:
  enabled: true
  model: deepseek-reasoner
  endpoint: https://example.internal/v1/chat
  timeout: 45

quota:
  rounds: 5
  player_tokens: 50000
  global_tokens: 1000000
  max_concurrency: 4
`,
	})
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AI.Enabled || cfg.AI.Model != "deepseek-reasoner" || cfg.AI.Endpoint != "https://example.internal/v1/chat" {
		t.Fatalf("ai = %+v", cfg.AI)
	}
	if cfg.AI.Timeout != 45*time.Second {
		t.Fatalf("timeout = %v", cfg.AI.Timeout)
	}
	if cfg.Quota.PlayerRounds != 5 || cfg.Quota.PlayerTokens != 50_000 ||
		cfg.Quota.GlobalTokens != 1_000_000 || cfg.Quota.MaxConcurrency != 4 {
		t.Fatalf("quota = %+v", cfg.Quota)
	}
	if cfg.APIKey != "" {
		t.Fatal("key must not come from config.yaml")
	}
}

func TestLoadServerConfigEnvFileAndPrecedence(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{
		"config.yaml": "ai:\n  enabled: true\n  model: from-config\nquota:\n  rounds: 7\n",
		".env":        "DEEPSEEK_API_KEY=sk-from-env-file\nAI_MODEL=from-env-file\n",
	})
	t.Setenv(EnvKey, "")
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	// .env 覆盖 config.yaml。
	if cfg.APIKey != "sk-from-env-file" || cfg.AI.Model != "from-env-file" {
		t.Fatalf("precedence: key=%q model=%q", cfg.APIKey, cfg.AI.Model)
	}

	// 进程环境 > .env。
	t.Setenv(EnvKey, "sk-from-process-env")
	t.Setenv("AI_MODEL", "from-process-env")
	cfg, err = LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-from-process-env" || cfg.AI.Model != "from-process-env" {
		t.Fatalf("process env lost: key=%q model=%q", cfg.APIKey, cfg.AI.Model)
	}
}

func TestLoadServerConfigExplicitEnvDir(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{
		".env": "AI_ENABLED=true\nDEEPSEEK_API_KEY=sk-explicit-dir\n",
	})
	t.Setenv("OMB_CONFIG_DIR", dir)
	t.Setenv(EnvKey, "")
	cfg, err := LoadServerConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AI.Enabled || cfg.APIKey != "sk-explicit-dir" {
		t.Fatalf("explicit dir config = %+v key=%q", cfg.AI, cfg.APIKey)
	}
}

func TestLoadServerConfigFlatKeysAndComments(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{
		"config.yaml": `ai.enabled: true
ai.timeout: "90s"
quota.max_concurrency: 3   # inline comment
`,
	})
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AI.Enabled || cfg.AI.Timeout != 90*time.Second || cfg.Quota.MaxConcurrency != 3 {
		t.Fatalf("flat config: %+v %+v", cfg.AI, cfg.Quota)
	}
}

func TestLoadServerConfigRejectsMalformed(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{"config.yaml": "ai:\n  enabled true\n"})
	if _, err := LoadServerConfig(dir); err == nil {
		t.Fatal("malformed yaml accepted")
	}
	writeConfig(t, dir, map[string]string{".env": "DEEPSEEK_API_KEY\n"})
	if _, err := LoadServerConfig(dir); err == nil {
		t.Fatal("malformed .env accepted")
	}
}

func TestLoadServerConfigDirAutoDetectFallsBackToCWD(t *testing.T) {
	// 显式 dir 存在时永远用显式 dir（探测逻辑只服务 dir=""）。
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{".env": "DEEPSEEK_API_KEY=sk-x\n"})
	t.Chdir(t.TempDir()) // cwd 无配置
	t.Setenv(EnvKey, "")
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "sk-x" {
		t.Fatalf("explicit dir ignored: %q", cfg.APIKey)
	}
}

func TestLoadServerConfigQuotaEnvOverride(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{"config.yaml": "quota:\n  rounds: 9\n"})
	t.Setenv("QUOTA_ROUNDS", "11")
	t.Setenv("QUOTA_MAX_CONCURRENCY", "2")
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Quota.PlayerRounds != 11 || cfg.Quota.MaxConcurrency != 2 {
		t.Fatalf("env quota override: %+v", cfg.Quota)
	}
}

// TestLoadServerConfigAuthYAMLEnv：auth.* 段 yaml 非秘密键 + .env/环境变量
// 秘密键的组合装配；未配置时 TokenTTL 落默认 168h。
func TestLoadServerConfigAuthYAMLEnv(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{
		"config.yaml": `auth:
  enabled: true
  issuer: https://sso.example/realms/omb
  client_id: omb
  redirect_url: https://omb.example/auth/callback
  display_name_claim: email
  token_ttl: 24h
  bypass_proxy: true
`,
		".env": "OIDC_CLIENT_SECRET=oidc-secret\nOMB_AUTH_SECRET=hmac-secret\n",
	})
	// 隔离进程环境同名键：本机若导出过这些变量会污染断言。
	for _, key := range []string{"OIDC_CLIENT_SECRET", "OMB_AUTH_SECRET", "AUTH_ENABLED", "AUTH_ISSUER", "AUTH_CLIENT_ID", "AUTH_BYPASS_PROXY"} {
		t.Setenv(key, "")
	}
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := cfg.Auth
	if !a.Enabled || a.Issuer != "https://sso.example/realms/omb" || a.ClientID != "omb" ||
		a.RedirectURL != "https://omb.example/auth/callback" || a.DisplayNameClaim != "email" || !a.BypassProxy {
		t.Fatalf("auth yaml = %+v", a)
	}
	if a.TokenTTL != 24*time.Hour {
		t.Fatalf("token_ttl = %v, want 24h", a.TokenTTL)
	}
	if a.ClientSecret != "oidc-secret" || a.HMACSecret != "hmac-secret" {
		t.Fatalf("secrets = %q/%q", a.ClientSecret, a.HMACSecret)
	}

	// 未配置时 Enabled 默认 true（配齐 issuer 等即生效），TTL 落默认值。
	cfg2, err := LoadServerConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !cfg2.Auth.Enabled || cfg2.Auth.TokenTTL != AuthDefaultTokenTTL {
		t.Fatalf("auth defaults = %+v", cfg2.Auth)
	}
}

// TestLoadServerConfigAuthDisableViaEnv：默认开启的前提下，.env 显式
// AUTH_ENABLED=false 可在配置齐备时关掉认证（显式关闭优先，且不丢其余配置）。
func TestLoadServerConfigAuthDisableViaEnv(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, map[string]string{
		"config.yaml": "auth:\n  issuer: https://sso.example/realms/omb\n  client_id: omb\n",
		".env":        "OIDC_CLIENT_SECRET=s\nAUTH_ENABLED=false\n",
	})
	// 隔离宿主机可能存在的同名环境变量（空串按未设置处理）。
	t.Setenv("AUTH_ENABLED", "")
	t.Setenv("OIDC_CLIENT_SECRET", "")
	cfg, err := LoadServerConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Auth.Enabled {
		t.Fatalf("explicit AUTH_ENABLED=false must disable auth: %+v", cfg.Auth)
	}
	if cfg.Auth.Issuer == "" || cfg.Auth.ClientSecret != "s" {
		t.Fatalf("disabled switch must not discard the rest of the config: %+v", cfg.Auth)
	}
}
