package sim

import "bytes"

// logBuffer 简单内存 JSONL 缓冲（snippet control 记录往返测试用）。
type logBuffer struct {
	bytes.Buffer
}

func (b *logBuffer) reader() *bytes.Reader { return bytes.NewReader(b.Bytes()) }
