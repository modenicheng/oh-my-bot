package ai

import "testing"

func TestLogConfigPrecedence(t *testing.T) {
	for _, key := range []string{"OMB_LOG_LEVEL", "OMB_LOG_FORMAT", "OMB_LOG_SOURCE"} {
		t.Setenv(key, "")
	}
	dir := t.TempDir()
	cfg, err := LoadServerConfig(dir)
	if err != nil || cfg.Log.Level != "info" || cfg.Log.Format != "text" || cfg.Log.Source {
		t.Fatalf("incorrect defaults: %+v, %v", cfg.Log, err)
	}
	writeConfig(t, dir, map[string]string{"config.yaml": "log:\n  level: debug\n  format: json\n  source: true\n"})
	cfg, err = LoadServerConfig(dir)
	if err != nil || cfg.Log.Level != "debug" || cfg.Log.Format != "json" || !cfg.Log.Source {
		t.Fatalf("YAML not applied: %+v, %v", cfg.Log, err)
	}
	writeConfig(t, dir, map[string]string{".env": "OMB_LOG_LEVEL=warn\nOMB_LOG_FORMAT=text\nOMB_LOG_SOURCE=false\n"})
	cfg, err = LoadServerConfig(dir)
	if err != nil || cfg.Log.Level != "warn" || cfg.Log.Format != "text" || cfg.Log.Source {
		t.Fatalf(".env not applied: %+v, %v", cfg.Log, err)
	}
	t.Setenv("OMB_LOG_LEVEL", "error")
	t.Setenv("OMB_LOG_FORMAT", "json")
	t.Setenv("OMB_LOG_SOURCE", "true")
	cfg, err = LoadServerConfig(dir)
	if err != nil || cfg.Log.Level != "error" || cfg.Log.Format != "json" || !cfg.Log.Source {
		t.Fatalf("environment not applied: %+v, %v", cfg.Log, err)
	}
}
