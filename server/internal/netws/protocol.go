package netws

import (
	"net/http"
	"strings"

	"github.com/modenicheng/oh-my-bot/server/internal/wire"
)

// OffersCompactProtocol mirrors this handler's only supported subprotocol. It is
// used when assembling a session, before its first snapshot is produced.
func OffersCompactProtocol(r *http.Request) bool {
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, protocol := range strings.Split(header, ",") {
			if strings.TrimSpace(protocol) == wire.Subprotocol {
				return true
			}
		}
	}
	return false
}
