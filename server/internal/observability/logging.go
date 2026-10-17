// Package observability provides application logging and request correlation.
package observability

import (
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
)

type Config struct {
	Level  string
	Format string
	Source bool
}

func DefaultConfig() Config { return Config{Level: "info", Format: "text"} }

// NewLogger validates the final configuration after all overrides have been applied.
func NewLogger(output io.Writer, cfg Config) (*slog.Logger, error) {
	var level slog.Level
	switch strings.ToLower(strings.TrimSpace(cfg.Level)) {
	case "", "info":
		level = slog.LevelInfo
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	case "off":
		level = slog.Level(127)
	default:
		return nil, fmt.Errorf("invalid log.level %q (use debug, info, warn, error or off)", cfg.Level)
	}
	opts := &slog.HandlerOptions{Level: level, AddSource: cfg.Source, ReplaceAttr: redactAttribute}
	var handler slog.Handler
	switch strings.ToLower(strings.TrimSpace(cfg.Format)) {
	case "", "text":
		handler = slog.NewTextHandler(output, opts)
	case "json":
		handler = slog.NewJSONHandler(output, opts)
	default:
		return nil, fmt.Errorf("invalid log.format %q (use text or json)", cfg.Format)
	}
	return slog.New(handler), nil
}

var diagnosticURL = regexp.MustCompile(`(?:https?|wss?)://[^\s<>"']+|/[^\s<>"']*[?#][^\s<>"']+`)
var bearerValue = regexp.MustCompile(`(?i)\bBearer\s+[^\s,;]+`)
var credentialValue = regexp.MustCompile(`(?i)\b(token|access_token|refresh_token|id_token|api_key|client_secret|password|code|state)=([^&\s]+)`)

func redactAttribute(_ []string, attr slog.Attr) slog.Attr {
	key := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(attr.Key))
	switch key {
	case "authorization", "cookie", "setcookie", "token", "accesstoken", "refreshtoken", "idtoken", "apikey", "clientsecret", "secret", "password", "prompt", "script", "body":
		attr.Value = slog.StringValue("[REDACTED]")
		return attr
	}
	value := attr.Value
	if err, ok := value.Any().(error); ok {
		value = slog.StringValue(err.Error())
	}
	if value.Kind() == slog.KindString {
		text := diagnosticURL.ReplaceAllStringFunc(value.String(), func(raw string) string {
			parsed, err := url.Parse(raw)
			if err != nil {
				return "[REDACTED_URL]"
			}
			private := parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil
			parsed.User, parsed.RawQuery, parsed.Fragment = nil, "", ""
			result := parsed.String()
			if private {
				result += "?[REDACTED]"
			}
			return result
		})
		text = bearerValue.ReplaceAllString(text, "Bearer [REDACTED]")
		attr.Value = slog.StringValue(credentialValue.ReplaceAllString(text, "$1=[REDACTED]"))
	}
	return attr
}
