// Package botapi 持有公开 Bot Script API 的权威语料（审计 X-1 单源化）。
//
// 权威源是 packages/bot-api/src/index.ts；本包内嵌其 verbatim 生成副本
// bot_api.gen.ts（Go embed 只能引用包目录内文件，故由
// `pnpm --filter @omb/bot-api gen` 生成）。三个消费方都从这里取文本：
//
//   - internal/ai：system prompt 的 API 类型摘要（替代手抄镜像）；
//   - internal/script：goja 绑定与权威源的契约测试；
//   - 本包测试：生成副本与权威源的逐字节新鲜度对拍。
//
// 修改 API 面时：先改 index.ts，再跑 gen，最后让两侧测试推动实现同步。
package botapi

import _ "embed"

// Source 是 @omb/bot-api 类型定义全文（与 packages/bot-api/src/index.ts
// 逐字节一致；漂移由 TestGeneratedSourceIsFresh 对拍拦截）。
//
//go:embed bot_api.gen.ts
var Source string
