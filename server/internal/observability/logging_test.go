package observability

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestLoggerFiltersLevelsAndWritesStructuredFields(t *testing.T) {
	var output bytes.Buffer
	logger, err := NewLogger(&output, Config{Level: "warn", Format: "json"})
	if err != nil {
		t.Fatal(err)
	}
	logger.Debug("hidden debug")
	logger.Info("hidden info")
	logger.Warn("ws.overload", "request_id", "request-123", "dropped", 4)
	logger.Error("visible error")
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("want two records, got %s", &output)
	}
	var record map[string]any
	if err := json.Unmarshal(lines[0], &record); err != nil {
		t.Fatal(err)
	}
	if record["level"] != "WARN" || record["request_id"] != "request-123" || record["dropped"] != float64(4) {
		t.Fatalf("missing structured fields: %v", record)
	}
}

func TestLoggerConfiguration(t *testing.T) {
	for _, cfg := range []Config{{Level: "verbose"}, {Format: "xml"}} {
		if _, err := NewLogger(&bytes.Buffer{}, cfg); err == nil {
			t.Fatalf("accepted invalid configuration: %+v", cfg)
		}
	}
	var output bytes.Buffer
	logger, err := NewLogger(&output, Config{Level: "off"})
	if err != nil {
		t.Fatal(err)
	}
	logger.Log(t.Context(), slog.LevelError, "hidden")
	if output.Len() != 0 {
		t.Fatalf("off logger wrote: %s", &output)
	}
}

func TestLoggerRedactsCredentialsInErrors(t *testing.T) {
	var output bytes.Buffer
	logger, err := NewLogger(&output, Config{Format: "json"})
	if err != nil {
		t.Fatal(err)
	}
	logger.Error("auth.exchange_failed", "error", errors.New("Post https://user:hidden-password@issuer.test/token?code=hidden-code&state=hidden-state: connection refused"),
		"authorization", "Bearer hidden-bearer", "access_token", "hidden-access")
	if strings.Contains(output.String(), "hidden-") || !strings.Contains(output.String(), "connection refused") {
		t.Fatalf("incorrect error redaction: %s", &output)
	}
}
