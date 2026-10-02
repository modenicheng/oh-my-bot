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
