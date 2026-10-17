package main

import (
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func TestHostSpectatorProtocolFieldsRoundTrip(t *testing.T) {
	defaults := &ombv1.JoinRoom{}
	if defaults.GetSpectatorMode() {
		t.Fatal("JoinRoom spectator_mode defaulted to true")
	}
	if (&ombv1.EvRoomState{}).GetHostSpectator() {
		t.Fatal("EvRoomState host_spectator defaulted to true")
	}

	joinBytes, err := proto.Marshal(&ombv1.JoinRoom{SpectatorMode: true})
	if err != nil {
		t.Fatal(err)
	}
	var join ombv1.JoinRoom
	if err := proto.Unmarshal(joinBytes, &join); err != nil {
		t.Fatal(err)
	}
	if !join.GetSpectatorMode() {
		t.Fatal("JoinRoom spectator_mode did not round-trip")
	}

	stateBytes, err := proto.Marshal(&ombv1.EvRoomState{HostSpectator: true})
	if err != nil {
		t.Fatal(err)
	}
	var state ombv1.EvRoomState
	if err := proto.Unmarshal(stateBytes, &state); err != nil {
		t.Fatal(err)
	}
	if !state.GetHostSpectator() {
		t.Fatal("EvRoomState host_spectator did not round-trip")
	}
}
