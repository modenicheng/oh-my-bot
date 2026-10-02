// Package listen turns the -addr listen specification into a net.Listener.
//
// Accepted forms:
//
//	"" / "127.0.0.1:27182"   TCP on the loopback interface (safe default)
//	":port"                  TCP on all interfaces (explicit exposure)
//	"unix:/path/to/omb.sock" unix socket file (reverse-proxy deployments)
//	"unix:@name"             Linux abstract unix socket (no file, no cleanup)
package listen

import (
	"errors"
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Default is the listen address used when neither -addr nor OMB_ADDR is set.
// Loopback keeps local debugging off external interfaces unless exposure is
// requested explicitly (docs/adr/0014-loopback-first-listen.md).
const Default = "127.0.0.1:27182"

// Listen resolves spec ("" means Default) into a ready listener. Go's
// UnixListener unlinks its own socket path once, on the first Close.
func Listen(spec string) (net.Listener, error) {
	network, address, err := Resolve(spec)
	if err != nil {
		return nil, err
	}
	if network == "tcp" {
		return net.Listen(network, address)
	}
	return listenUnix(address)
}

// Resolve classifies spec into a network and address for net.Listen.
func Resolve(spec string) (network, address string, err error) {
	if spec == "" {
		return "tcp", Default, nil
	}
	if rest, ok := strings.CutPrefix(spec, "unix:"); ok {
		path := strings.TrimSpace(rest)
		if path == "" {
			return "", "", fmt.Errorf("listen %q: unix: requires a non-empty socket path", spec)
		}
		if strings.HasPrefix(path, "@") && runtime.GOOS != "linux" {
			return "", "", fmt.Errorf("listen %q: abstract sockets require Linux", spec)
		}
		return "unix", path, nil
	}
	if _, _, splitErr := net.SplitHostPort(spec); splitErr != nil {
		return "", "", fmt.Errorf("listen %q: want host:port, :port, or unix:<path>", spec)
	}
	return "tcp", spec, nil
}

// listenUnix binds a unix socket. A socket file left by an unclean shutdown is
// removed before bind, but one still answering for a live process is an
// "already in use" error — silently stealing the path would strand the old
// instance on its orphaned socket. Mode 0o666 lets a reverse proxy running as
// another user connect; tighten to a shared group for harder isolation.
func listenUnix(path string) (net.Listener, error) {
	if strings.HasPrefix(path, "@") {
		return net.Listen("unix", path)
	}
	if err := removeStaleSocket(path); err != nil {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o666); err != nil {
		_ = ln.Close() // chmod 失败时 close 错误无信息量，返回 chmod 错误
		return nil, err
	}
	return ln, nil
}

func removeStaleSocket(path string) error {
	before, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if before.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("refusing to replace non-socket path %s", path)
	}
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err == nil {
		_ = conn.Close() // 探活连接，close 错误无信息量
		return fmt.Errorf("unix socket %s already in use (is another instance running?)", path)
	}
	// A timeout or permission failure does not prove the listener is gone.
	// Winsock uses WSAECONNREFUSED (10061), not syscall.ECONNREFUSED.
	refused := errors.Is(err, syscall.ECONNREFUSED) ||
		(runtime.GOOS == "windows" && errors.Is(err, syscall.Errno(10061)))
	if !refused {
		return fmt.Errorf("probe unix socket %s: %w", path, err)
	}
	after, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(before, after) {
		return fmt.Errorf("unix socket %s changed during probe; retry startup", path)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale unix socket %s: %w", path, err)
	}
	return nil
}
