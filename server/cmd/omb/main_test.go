package main

import "testing"

func TestLogErr(t *testing.T) {
	if logErr(nil) {
		t.Fatal("nil error must not be fatal")
	}
}
