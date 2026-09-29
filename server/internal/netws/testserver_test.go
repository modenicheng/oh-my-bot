package netws

import (
	"net/http"
	"net/http/httptest"
)

func httptest_server(h http.Handler) *httptest.Server {
	return httptest.NewServer(h)
}
