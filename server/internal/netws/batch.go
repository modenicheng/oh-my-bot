package netws

import (
	"encoding/binary"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/wire"
)

const batchCollectionWindow = time.Millisecond

func batchable(frame queuedFrame) bool {
	return !frame.bootstrap && frame.snapshot == nil && frame.scriptLog == nil && len(frame.data) > 1 && frame.data[0] == frameDown
}

// Collection is writer-local: never wait a simulation tick or hold the room lock.
// A boundary/oversized child is retained for the next write, not dropped.
func collectReliableBatch(first queuedFrame, queue <-chan queuedFrame, graceful <-chan struct{}) ([]byte, *queuedFrame) {
	if 8+len(first.data) > wire.MaxFrameBytes {
		return first.data, nil
	}
	children := [][]byte{first.data}
	size := 8 + len(first.data)
	end := time.Now().Add(batchCollectionWindow)
	deadline := time.NewTimer(batchCollectionWindow)
	defer deadline.Stop()
	var pending *queuedFrame
collect:
	for len(children) < wire.MaxBatchChildren {
		// A permanently ready queue must obey the collection window too.
		if !time.Now().Before(end) {
			break
		}
		var next queuedFrame
		select {
		case next = <-queue:
		default:
			select {
			case next = <-queue:
			case <-deadline.C:
				break collect
			case <-graceful:
				break collect
			}
		}
		if !batchable(next) || size+4+len(next.data) > wire.MaxFrameBytes {
			pending = &next
			break
		}
		children = append(children, next.data)
		size += 4 + len(next.data)
	}
	if len(children) == 1 {
		return first.data, pending
	}
	data := make([]byte, 4, size)
	data[0], data[1] = wire.FrameBatch, 1
	binary.LittleEndian.PutUint16(data[2:], uint16(len(children)))
	for _, child := range children {
		data = binary.LittleEndian.AppendUint32(data, uint32(len(child)))
		data = append(data, child...)
	}
	return data, pending
}
