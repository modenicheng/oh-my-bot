// @omb/bot-api 生成器核心（审计 X-1 单源化）。
// 纯函数库：解析 packages/bot-api/src/index.ts 的 interface 面，渲染
// Go embed 语料与 Monaco 补全表。无副作用、无第三方依赖；
// gen.mjs（写盘 CLI）与 bot-api-drift.test.ts（新鲜度对拍）共同消费。

/** 权威源文本 → interface 成员模型。 */
export function parseInterfaces(source) {
  const ifaces = new Map()
  const lines = source.split('\n')
  let cur = null
  let docBuf = []
  for (const line of lines) {
    const t = line.trim()
    if (!cur) {
      const header = /^export interface (\w+)[^{]*\{/.exec(t)
      if (header) {
        cur = { name: header[1], members: [], body: null }
        const open = line.indexOf('{')
        const rest = line.slice(open + 1)
        if (rest.includes('}')) {
          // 单行 interface（如 Vec2/RobotRef/WallRef）：body 为大括号内文本。
          cur.body = rest.slice(0, rest.lastIndexOf('}'))
          ifaces.set(cur.name, cur)
          cur = null
        }
      }
      continue
    }
    if (t === '}') {
      ifaces.set(cur.name, cur)
      cur = null
      docBuf = []
      continue
    }
    if (!t) continue
    if (t.startsWith('/**') || t.startsWith('*') || t.startsWith('//')) {
      docBuf.push(t)
      continue
    }
    const member = parseMember(t, docBuf)
    if (member) cur.members.push(member)
    docBuf = []
  }
  // 单行 interface 拆分成员。
  for (const iface of ifaces.values()) {
    if (iface.body === null) continue
    for (const part of iface.body.split(';')) {
      const t = part.trim()
      if (t) {
        const member = parseMember(t, [])
        if (member) iface.members.push(member)
      }
    }
  }
  return ifaces
}

function jsdocText(docLines) {
  if (!docLines.length) return ''
  return docLines
    .map(l => l.replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/。$/, '')
    .trim()
}

function parseMember(text, docLines) {
  const jsdoc = jsdocText(docLines)
  const method = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:\s*(.+)$/.exec(text)
  if (method) {
    return {
      kind: 'method',
      name: method[1],
      params: parseParams(method[2]),
      ret: method[3].trim(),
      doc: jsdoc,
      deprecated: /@deprecated/.test(docLines.join(' ')),
    }
  }
  const prop = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*(.+)$/.exec(text)
  if (prop) {
    const [rawType, lineComment] = prop[2].split('//')
    const type = rawType.trim()
    const doc = jsdoc || (lineComment ?? '').trim().replace(/。$/, '')
    return {
      kind: 'property',
      name: prop[1],
      type,
      doc,
      deprecated: /@deprecated/.test(docLines.join(' ')),
    }
  }
  return null
}

function parseParams(text) {
  const t = text.trim()
  if (!t) return []
  return t.split(',').map(part => {
    const [name, type] = part.trim().replace(/^\.\.\./, '').split(':')
    return { name: name.trim(), type: (type ?? 'unknown').trim() }
  })
}

/** 接口成员名（保持源顺序；注释行已滤除）。 */
export function interfaceMemberNames(iface) {
  return iface.members.map(m => m.name)
}

// ---- Monaco 补全表渲染 ----

function methodSignature(m) {
  const params = m.params.map(p => `${p.name}: ${p.type}`).join(', ')
  return `${m.name}(${params}): ${m.ret}`
}

function methodInsert(m) {
  const placeholders = m.params.map((_, i) => `$${i + 1}`).join(', ')
  return `${m.name}(${placeholders})`
}

function seedForMethod(m) {
  const sig = methodSignature(m)
  return {
    label: m.name,
    insert: methodInsert(m),
    kind: 'method',
    detail: m.doc ? `${sig} — ${m.doc}` : sig,
  }
}

function seedForProperty(m) {
  const sig = `${m.name}: ${m.type}`
  return {
    label: m.name,
    insert: m.name,
    kind: 'property',
    detail: m.doc ? `${sig} — ${m.doc}` : sig,
  }
}

/** 同名重载（L0/L1 aimAt）合并为一个补全项：参数按位 `|`、文档以 `；` 连接。 */
function mergeMethodSeeds(methods) {
  if (methods.length === 1) return seedForMethod(methods[0])
  const maxLen = Math.max(...methods.map(m => m.params.length))
  const params = []
  for (let i = 0; i < maxLen; i++) {
    // 参数名取第一个声明；类型按位去重后 `|` 连接（名称不同时如 angle/target，
    // 补全详情只展示类型联合，语义不受名称影响）。
    const owner = methods.find(m => m.params[i])
    const types = [...new Set(methods.map(m => m.params[i]).filter(Boolean).map(p => p.type))]
    params.push({ name: owner.params[i].name, type: types.join(' | ') })
  }
  const merged = {
    ...methods[0],
    params,
    ret: methods[0].ret,
    doc: [...new Set(methods.map(m => m.doc).filter(Boolean))].join('；'),
  }
  return seedForMethod(merged)
}

/**
 * bot 接收者补全 = L0 方法 ∪ L1 方法 ∪ BotContext 自有成员（self/game/scan）。
 * deprecated 的 api 属性刻意不推荐（与 bot-completions.test.ts 约定一致）。
 */
export function botMemberSeeds(ifaces) {
  const l0 = ifaces.get('L0')
  const l1 = ifaces.get('L1')
  const ctx = ifaces.get('BotContext')
  if (!l0 || !l1 || !ctx) throw new Error('index.ts must declare L0, L1 and BotContext')

  const byName = new Map()
  const order = []
  const pushMethod = m => {
    if (m.deprecated) return
    if (!byName.has(m.name)) {
      byName.set(m.name, [])
      order.push(m.name)
    }
    byName.get(m.name).push(m)
  }
  for (const m of l0.members) if (m.kind === 'method') pushMethod(m)
  for (const m of l1.members) if (m.kind === 'method') pushMethod(m)

  const seeds = []
  const seenProps = new Set()
  for (const name of order) seeds.push(mergeMethodSeeds(byName.get(name)))
  for (const m of ctx.members) {
    if (m.deprecated || seenProps.has(m.name) || byName.has(m.name)) continue
    if (m.kind === 'property') {
      seeds.push(seedForProperty(m))
      seenProps.add(m.name)
    } else {
      seeds.push(seedForMethod(m))
      byName.set(m.name, [m])
    }
  }
  return seeds
}

export function memberSeeds(ifaces, name) {
  const iface = ifaces.get(name)
  if (!iface) throw new Error(`index.ts must declare ${name}`)
  return iface.members.map(m => (m.kind === 'method' ? seedForMethod(m) : seedForProperty(m)))
}

export function renderCompletionModule(source) {
  const ifaces = parseInterfaces(source)
  const tables = [
    ['BOT_MEMBER_SEEDS', botMemberSeeds(ifaces)],
    ['SELF_MEMBER_SEEDS', memberSeeds(ifaces, 'Self')],
    ['GAME_MEMBER_SEEDS', memberSeeds(ifaces, 'GameInfo')],
    ['OBSERVATION_MEMBER_SEEDS', memberSeeds(ifaces, 'Observation')],
    ['PROJECTILE_MEMBER_SEEDS', memberSeeds(ifaces, 'ProjectileRef')],
  ]
  const header = [
    '// 自动生成（审计 X-1）：由 packages/bot-api/src/index.ts 生成，勿手改。',
    '// 再生成：pnpm --filter @omb/bot-api gen（新鲜度由 bot-api-drift.test.ts 对拍）。',
    '',
    "export type CompletionSeedKind = 'method' | 'property' | 'keyword' | 'snippet'",
    '',
    'export interface CompletionSeed {',
    '  label: string',
    '  insert: string',
    '  kind: CompletionSeedKind',
    '  detail: string',
    '}',
    '',
  ]
  const body = tables.map(([name, seeds]) => {
    const lines = [`export const ${name}: CompletionSeed[] = [`]
    for (const s of seeds) {
      lines.push(`  { label: ${JSON.stringify(s.label)}, insert: ${JSON.stringify(s.insert)}, kind: '${s.kind}', detail: ${JSON.stringify(s.detail)} },`)
    }
    lines.push(']', '')
    return lines.join('\n')
  })
  return header.join('\n') + body.join('\n').replace(/\n$/, '\n')
}
