#!/usr/bin/env node
// @omb/bot-api 单源扇出生成器（审计 X-1）。
// 权威源 packages/bot-api/src/index.ts 生成：
//   1. server/internal/botapi/bot_api.gen.ts —— verbatim 副本，Go go:embed 消费
//      （AI system prompt + 运行时契约测试）；
//   2. client/src/workbench/bot-completions.gen.ts —— Monaco 补全表。
// 确定性输出（无时间戳/平台差异），生成物随仓库检入。
// 用法：pnpm --filter @omb/bot-api gen   （或 node packages/bot-api/scripts/gen.mjs）

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderCompletionModule } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')

const source = readFileSync(join(pkgRoot, 'src/index.ts'), 'utf8')

// Go embed 目标：server/internal/botapi（embed 只能引用包目录内文件，
// 故生成 verbatim 副本；新鲜度由 botapi 包测试对拍权威源）。
const goEmbedPath = join(repoRoot, 'server/internal/botapi/bot_api.gen.ts')
mkdirSync(dirname(goEmbedPath), { recursive: true })
writeFileSync(goEmbedPath, source, 'utf8')

// Monaco 补全表：手写方法表的历史替代（原 bot-completions.ts 常量表删除）。
const completionsPath = join(repoRoot, 'client/src/workbench/bot-completions.gen.ts')
writeFileSync(completionsPath, renderCompletionModule(source), 'utf8')

console.log(`gen: ${source.length} bytes source -> bot_api.gen.ts + bot-completions.gen.ts`)
