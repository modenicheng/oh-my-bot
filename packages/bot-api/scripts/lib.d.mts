/**
 * bot-api 生成器纯函数库的类型声明（lib.mjs 的 .d.mts，供客户端
 * bot-api-drift.test.ts 静态导入做新鲜度对拍；实现见 lib.mjs）。
 */

/** 权威源 interface 成员模型（方法或属性）。 */
export interface BotApiMember {
  kind: 'method' | 'property'
  name: string
  /** 方法参数（属性无）。 */
  params?: { name: string; type: string }[]
  /** 方法返回类型或属性类型。 */
  ret?: string
  type?: string
  /** 归一化 JSDoc/行内注释（无则空串）。 */
  doc: string
  deprecated: boolean
}

export interface BotApiInterface {
  name: string
  members: BotApiMember[]
  /** 单行 interface 的原始 body（多行 interface 为 null）。 */
  body: string | null
}

/** 权威源文本 → interface 成员模型（含单行 interface 拆分）。 */
export function parseInterfaces(source: string): Map<string, BotApiInterface>

/** 接口成员名（保持源顺序）。 */
export function interfaceMemberNames(iface: BotApiInterface): string[]

/** bot 接收者补全种子 = L0 ∪ L1 ∪ BotContext 自有成员（deprecated 除外）。 */
export function botMemberSeeds(ifaces: Map<string, BotApiInterface>): CompletionSeedLike[]

/** 指定 interface 的成员补全种子。 */
export function memberSeeds(ifaces: Map<string, BotApiInterface>, name: string): CompletionSeedLike[]

/** 渲染 bot-completions.gen.ts 全文（确定性输出）。 */
export function renderCompletionModule(source: string): string

/** 与 client/src/workbench/bot-completions.gen.ts 同形。 */
export interface CompletionSeedLike {
  label: string
  insert: string
  kind: 'method' | 'property' | 'keyword' | 'snippet'
  detail: string
}
