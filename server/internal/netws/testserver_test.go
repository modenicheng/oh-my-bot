package netws

import (
	"net/http"
	"net/http/httptest"
)

type testserverT = httptest.Server

func newTestServer(h http.Handler) *httptest.Server { return httptest.NewServer(h) }
