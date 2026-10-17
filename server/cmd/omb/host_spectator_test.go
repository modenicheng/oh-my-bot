package main

import (
	"sync"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestHostSpectatorJoinKeepsCreatorDurations(t *testing.T) {
	for _, custom := range []bool{false, true} {
		name := "defaults"
		if custom {
			name = "custom"
		}
		t.Run(name, func(t *testing.T) {
			h := glue.NewHub()
			send := func(*ombv1.ServerMsg) {}
			var host, guest *glue.Session
			join := &ombv1.JoinRoom{RoomCode: "HOSTDR", Nick: "host", SpectatorMode: true}
			if custom {
				join.MatchMinutes, join.CoreOpenMinutes = 3, 1
			}
			handleJoin(h, join, send, send, nil, nil, &host, "")
			if host == nil || !host.IsHostSpectator() {
				t.Fatal("spectator host did not bind")
			}
			handleJoin(h, &ombv1.JoinRoom{RoomCode: "HOSTDR", Nick: "guest",
				MatchMinutes: 2, CoreOpenMinutes: 1, SpectatorMode: true},
				send, send, nil, nil, &guest, "")
			if guest == nil || guest.IsHostSpectator() {
				t.Fatal("later Join did not bind a player")
			}
			match, core := h.EnsureRoom("HOSTDR").Room.DurationConfig()
			if custom {
				if match != 10800 || core != 3600 {
					t.Fatalf("late Join changed custom duration config to %d/%d", match, core)
				}
			} else if match != 0 && match != sim.MatchTicks || core != 0 && core != sim.CoreOpenTick {
				t.Fatalf("late Join changed default duration config to %d/%d", match, core)
			}
		})
	}
}

func hostSpectatorBlockedMessages() []*ombv1.ClientMsg {
	return []*ombv1.ClientMsg{
		{Payload: &ombv1.ClientMsg_Join{Join: &ombv1.JoinRoom{RoomCode: "HOSTSEC", Nick: "host", SpectatorMode: true}}},
		{Payload: &ombv1.ClientMsg_Spectate{Spectate: &ombv1.SpectateRoom{RoomCode: "HOSTSEC"}}},
		{Payload: &ombv1.ClientMsg_Input{Input: &ombv1.ClientInput{Seq: 1, MoveX: 1000}}},
		{Payload: &ombv1.ClientMsg_WarmupInput{WarmupInput: &ombv1.ClientInput{Seq: 2, Fire: true}}},
		{Payload: &ombv1.ClientMsg_ScriptSubmit{ScriptSubmit: &ombv1.ScriptSubmit{Source: "function tick() {}"}}},
		{Payload: &ombv1.ClientMsg_ScriptRollback{ScriptRollback: &ombv1.ScriptRollback{VersionId: 1}}},
		{Payload: &ombv1.ClientMsg_Say{Say: &ombv1.Say{Text: "blocked"}}},
		{Payload: &ombv1.ClientMsg_AiPrompt{AiPrompt: &ombv1.AiPrompt{Text: "blocked"}}},
		{Payload: &ombv1.ClientMsg_AssistToggle{AssistToggle: &ombv1.AssistToggle{}}},
		{Payload: &ombv1.ClientMsg_SnippetConfig{SnippetConfig: &ombv1.SnippetConfig{}}},
		{Payload: &ombv1.ClientMsg_UpgradeRequest{UpgradeRequest: &ombv1.UpgradeRequest{Track: 1}}},
	}
}

func TestHostSpectatorUpstreamBlocksAllPlayerActions(t *testing.T) {
	h := glue.NewHub()
	var received []*ombv1.ServerMsg
	send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
	var session *glue.Session
	handleJoin(h, &ombv1.JoinRoom{RoomCode: "HOSTSEC", Nick: "host", SpectatorMode: true},
		send, send, nil, nil, &session, "")
	if session == nil || !session.IsHostSpectator() || !session.IsHost() {
		t.Fatal("host control connection not established")
	}
	original := session
	rc := h.EnsureRoom("HOSTSEC")
	for _, cmd := range hostSpectatorBlockedMessages() {
		received = nil
		handleUpstream(h, cmd, send, send, nil, nil, &session, "")
		if session != original || !session.IsHostSpectator() || !session.IsHost() ||
			rc.Room.MemberCount() != 0 || len(rc.Room.SessionScores()) != 0 {
			t.Fatalf("%T changed the host role or created a seat", cmd.Payload)
		}
		if len(received) != 1 || received[0].GetEvent().GetControlNotice().GetCode() != ombv1.EvControlNotice_CN_READONLY_SPECTATOR {
			t.Fatalf("%T did not return readonly notice: %v", cmd.Payload, received)
		}
	}
	received = nil
	handleUpstream(h, &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_ResyncRequest{ResyncRequest: &ombv1.ResyncRequest{}}},
		send, send, nil, nil, &session, "")
	if len(received) != 0 || session != original {
		t.Fatal("idle resync changed the host connection")
	}
	handleUpstream(h, &ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Leave{Leave: &ombv1.LeaveRoom{}}},
		send, send, nil, nil, &session, "")
	if session != nil || rc.Room.HostID() != 0 {
		t.Fatal("explicit leave did not detach host")
	}
	handleJoin(h, &ombv1.JoinRoom{RoomCode: "HOSTSEC", Nick: "host"},
		send, send, nil, nil, &session, "")
	if session == nil || session.IsHostSpectator() || !session.IsHost() || rc.Room.MemberCount() != 1 {
		t.Fatal("explicitly released host identity could not rejoin as a fresh player")
	}
}

func TestHostSpectatorExternalSpectatorCannotClaimHost(t *testing.T) {
	h := glue.NewHub()
	var host, spectator *glue.Session
	sendHost := func(*ombv1.ServerMsg) {}
	handleJoin(h, &ombv1.JoinRoom{RoomCode: "HOSTSEC", Nick: "host", SpectatorMode: true},
		sendHost, sendHost, nil, nil, &host, "")
	h.Unregister(host)
	var received []*ombv1.ServerMsg
	send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
	handleSpectate(h, &ombv1.SpectateRoom{RoomCode: "HOSTSEC"}, send, send, nil, &spectator)
	original := spectator
	commands := append(hostSpectatorBlockedMessages(),
		&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_RoomAction{RoomAction: &ombv1.RoomAction{Kind: ombv1.RoomAction_SOLO_BOTS}}},
		&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_RoomAction{RoomAction: &ombv1.RoomAction{Kind: ombv1.RoomAction_START}}})
	for _, cmd := range commands {
		received = nil
		handleUpstream(h, cmd, send, send, nil, nil, &spectator, "")
		if spectator != original || !spectator.IsSpectator() || spectator.IsHost() {
			t.Fatalf("%T changed the external spectator role", cmd.Payload)
		}
		if len(received) != 2 || received[0].GetEvent().GetControlNotice().GetCode() != ombv1.EvControlNotice_CN_READONLY_SPECTATOR {
			t.Fatalf("%T was not rejected as readonly", cmd.Payload)
		}
	}
	rc := h.EnsureRoom("HOSTSEC")
	if !rc.Room.HostSpectator() || rc.Room.MemberCount() != 0 || rc.Room.SoloBots() != 0 {
		t.Fatal("external spectator mutated host room")
	}
}

func TestHostSpectatorSimultaneousCreatorsKeepWinnerConfig(t *testing.T) {
	for attempt := 0; attempt < 12; attempt++ {
		h := glue.NewHub()
		var hosts [2]*glue.Session
		start := make(chan struct{})
		var joins sync.WaitGroup
		for i, nick := range []string{"alice", "bob"} {
			joins.Add(1)
			go func() {
				defer joins.Done()
				<-start
				send := func(*ombv1.ServerMsg) {}
				handleJoin(h, &ombv1.JoinRoom{RoomCode: "HOSTCC", Nick: nick, SpectatorMode: true,
					MatchMinutes: uint32(i + 2), CoreOpenMinutes: 1},
					send, send, nil, nil, &hosts[i], "")
			}()
		}
		close(start)
		joins.Wait()
		for _, s := range hosts {
			if s == nil {
				t.Fatal("simultaneous creator lost admission")
			}
		}
		rc := h.EnsureRoom("HOSTCC")
		state := rc.Room.StateBroadcast()
		want := uint32(7200)
		if state.HostNick == "bob" {
			want = 10800
		}
		if match, core := rc.Room.DurationConfig(); match != want || core != 3600 {
			t.Fatalf("host %s got another Join's config: %d/%d, want %d/3600", state.HostNick, match, core, want)
		}
	}
}
