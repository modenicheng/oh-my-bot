package script

import (
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/sim"
	"github.com/modenicheng/oh-my-bot/server/internal/snippet"
)

func TestSnippetOnlyAndPlayerAxisPriority(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	defer rt.Close()

	aim := snippet.Setting{Kind: snippet.AutoAim}
	if err := rt.LoadSnippets([]snippet.Setting{aim}); err != nil {
		t.Fatalf("load snippet-only: %v", err)
	}
	cmd, err := rt.Tick(testFrame())
	if err != nil {
		t.Fatalf("snippet-only tick: %v", err)
	}
	if cmd.Aim == nil || cmd.SnippetAxes != sim.AxisAim {
		t.Fatalf("snippet-only attribution = %+v", cmd)
	}

	const playerMove = `function tick(bot) { bot.move(1, 0); }`
	if err := rt.Load(playerMove); err != nil {
		t.Fatalf("load player source: %v", err)
	}
	cmd, err = rt.Tick(testFrame())
	if err != nil {
		t.Fatalf("combined tick: %v", err)
	}
	if cmd.Move == nil || cmd.Aim == nil || cmd.SnippetAxes != sim.AxisAim {
		t.Fatalf("different axes did not coexist: %+v", cmd)
	}

	const playerAim = `function tick(bot) { bot.aimAt(0.25); }`
	if err := rt.Load(playerAim); err != nil {
		t.Fatalf("load player aim: %v", err)
	}
	cmd, err = rt.Tick(testFrame())
	if err != nil {
		t.Fatalf("priority tick: %v", err)
	}
	if cmd.Aim == nil || *cmd.Aim != 0.25 || cmd.SnippetAxes != 0 {
		t.Fatalf("player same-axis priority lost: %+v", cmd)
	}
}

func TestSnippetReloadPreservesPlayerSourceAndOldVersionOnFailure(t *testing.T) {
	rt := NewGojaRuntime(Config{})
	defer rt.Close()

	const source = `function tick(bot) { bot.move(0, 1); }`
	if err := rt.Load(source); err != nil {
		t.Fatal(err)
	}
	if err := rt.LoadSnippets([]snippet.Setting{{Kind: snippet.AutoAim}}); err != nil {
		t.Fatal(err)
	}
	beforeRev := rt.Rev()
	if got := rt.Source(); got != source {
		t.Fatalf("Source leaked wrapper: %q", got)
	}
	if _, accepted, err := rt.LoadIfRev(beforeRev, `function tick(bot) { bot.fire(); }`); err != nil || !accepted {
		t.Fatalf("AI-style reload: accepted=%v err=%v", accepted, err)
	}
	if len(rt.Snippets()) != 1 {
		t.Fatal("player reload dropped active snippets")
	}

	stableRev, stableSource := rt.Rev(), rt.Source()
	if err := rt.LoadSnippets([]snippet.Setting{{Kind: snippet.Kind(99)}}); err == nil {
		t.Fatal("unknown snippet kind accepted")
	}
	if rt.Rev() != stableRev || rt.Source() != stableSource || len(rt.Snippets()) != 1 {
		t.Fatal("failed snippet reload replaced active runtime")
	}
}
