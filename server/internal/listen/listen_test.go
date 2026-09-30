package listen

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestResolve(t *testing.T) {
	t.Parallel()
	cases := []struct {
		spec    string
		network string
		address string
		wantErr bool
	}{
		{spec: "", network: "tcp", address: Default},
		{spec: "127.0.0.1:27182", network: "tcp", address: "127.0.0.1:27182"},
		{spec: ":8080", network: "tcp", address: ":8080"},
		{spec: "[::1]:27182", network: "tcp", address: "[::1]:27182"},
		{spec: "unix:/run/omb/omb.sock", network: "unix", address: "/run/omb/omb.sock"},
		{spec: "unix:@omb-check", network: "unix", address: "@omb-check", wantErr: runtime.GOOS != "linux"},
		{spec: "unix:", wantErr: true},
		{spec: "27182", wantErr: true},
		{spec: "localhost", wantErr: true},
		{spec: "unix: ", wantErr: true},
	}
	for _, tc := range cases {
		network, address, err := Resolve(tc.spec)
		if tc.wantErr {
			if err == nil {
				t.Errorf("Resolve(%q) = %s/%s, want error", tc.spec, network, address)
			}
			continue
		}
		if err != nil {
			t.Errorf("Resolve(%q): %v", tc.spec, err)
			continue
		}
		if network != tc.network || address != tc.address {
			t.Errorf("Resolve(%q) = %s/%s, want %s/%s", tc.spec, network, address, tc.network, tc.address)
		}
	}
}

func TestListenTCP(t *testing.T) {
	t.Parallel()
	ln, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if _, port, err := net.SplitHostPort(ln.Addr().String()); err != nil || port == "0" {
		t.Fatalf("Listen addr = %v (err %v), want bound ephemeral port", ln.Addr(), err)
	}
}

// requireUnixSocket skips platforms without AF_UNIX (e.g. Windows < 10 1803).
func requireUnixSocket(t *testing.T) {
	t.Helper()
	probe := filepath.Join(t.TempDir(), "probe.sock")
	ln, err := net.Listen("unix", probe)
	if err != nil {
		t.Skipf("unix sockets unavailable on %s: %v", runtime.GOOS, err)
	}
	ln.Close()
}

func TestListenUnixLifecycle(t *testing.T) {
	requireUnixSocket(t)
	t.Parallel()
	path := filepath.Join(t.TempDir(), "omb.sock")
	ln, err := Listen("unix:" + path)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s mode = %v, want a socket", path, st.Mode())
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o666 {
		t.Fatalf("socket permissions = %v, want 0666", st.Mode().Perm())
	}
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Errorf("dial after listen: %v", err)
	} else {
		conn.Close()
	}
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket file after Close: %v, want removed", err)
	}
}

func TestListenUnixRemovesStaleSocketFile(t *testing.T) {
	requireUnixSocket(t)
	t.Parallel()
	path := filepath.Join(t.TempDir(), "omb.sock")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Net: "unix", Name: path})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("stale socket fixture: %v", err)
	}
	ln, err := Listen("unix:" + path)
	if err != nil {
		t.Fatalf("Listen over stale socket: %v, want it removed and bound", err)
	}
	ln.Close()
}

func TestListenUnixPreservesOtherFiles(t *testing.T) {
	requireUnixSocket(t)
	for _, kind := range []string{"regular", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "keep")
			switch kind {
			case "regular":
				if err := os.WriteFile(path, []byte("keep this file"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink("missing-target", path); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
			}
			before, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			ln, err := Listen("unix:" + path)
			if err == nil {
				ln.Close()
				t.Fatal("Listen should refuse a non-socket path")
			}
			after, err := os.Lstat(path)
			if err != nil || !os.SameFile(before, after) {
				t.Fatalf("Listen modified existing %s: %v", kind, err)
			}
			if kind == "regular" {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "keep this file" {
					t.Fatalf("file contents changed: %q, %v", data, err)
				}
			}
		})
	}
}

func TestClosedListenerDoesNotRemoveReplacement(t *testing.T) {
	requireUnixSocket(t)
	path := filepath.Join(t.TempDir(), "omb.sock")
	old, err := Listen("unix:" + path)
	if err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	replacement, err := Listen("unix:" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	_ = old.Close()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("old listener removed replacement: %v", err)
	}
	conn.Close()
}

func TestListenUnixRefusesLiveSocket(t *testing.T) {
	requireUnixSocket(t)
	t.Parallel()
	path := filepath.Join(t.TempDir(), "omb.sock")
	ln, err := Listen("unix:" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, err = Listen("unix:" + path)
	if err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("second Listen on live socket err = %v, want already-in-use", err)
	}
}

func TestListenAbstractSocket(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("abstract sockets are Linux-only")
	}
	t.Parallel()
	ln, err := Listen("unix:@omb-listen-test")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if got := ln.Addr().String(); got != "@omb-listen-test" {
		t.Fatalf("addr = %q, want @omb-listen-test", got)
	}
}
