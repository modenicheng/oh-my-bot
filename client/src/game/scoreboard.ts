import { Title } from '@omb/protocol'
import type { RobotEnt } from './world'
import { icon } from '../icons'
import './scoreboard.css'

export interface ScoreEntry { robot: number; score: number; titles?: readonly number[] }
export interface ReplayTitleEvidence { kill: number; hit: number; core: number; uplink: number; assist?: number }
export interface ScoreDisplay extends ScoreEntry { rank: number; nick: string; self: boolean; dead: boolean; status?: 'alive' | 'dead' | 'unknown'; respawnInS?: number; replayEvidence?: ReplayTitleEvidence }

export type ScoreRowOptions = { titles?: boolean; ended?: boolean }

export function scoreState(row: Pick<ScoreDisplay, 'self' | 'dead' | 'status' | 'respawnInS'>, ended = false): string {
  if (ended) return row.self ? '自己' : ''
  if (row.status === 'unknown') return row.self ? '自己' : ''
  if (row.dead || row.status === 'dead') {
    const seconds = row.respawnInS
    return `${row.self ? '自己 · ' : ''}阵亡 · ${Number.isFinite(seconds) && (seconds ?? 0) > 0 ? `${seconds!.toFixed(1)}s 后重生` : '等待重生同步'}`
  }
  return row.self ? '自己 · 存活' : '存活'
}

export function rankedScores<T extends ScoreEntry>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.robot - b.robot)
}

/** 实时榜以服务器为准；昵称可跨 AOI 缓存，但绝不从可见机器人推算分数。 */
export class Scoreboard {
  readonly names = new Map<number, string>()
  private rows: ScoreEntry[] = []
  private tick = -1
  private final = false
  private received = false
  /** display 缓存版本号：rows/names 变化即失效。 */
  private version = 0
  private displayCache: ScoreDisplay[] | null = null
  private displayKey = ''

  reset(): void { this.rows = []; this.tick = -1; this.final = false; this.received = false; this.names.clear(); this.version++; this.displayCache = null }
  observe(robots: ReadonlyMap<number, RobotEnt>): void {
    let changed = false
    for (const [id, robot] of robots) if (robot.nick && this.names.get(id) !== robot.nick) { this.names.set(id, robot.nick); changed = true }
    if (changed) { this.version++; this.displayCache = null }
  }
  accept(rows: readonly ScoreEntry[], tick: number, final = false): void {
    if (this.final || !final && tick < this.tick) return
    this.rows = rows.map(row => ({ robot: row.robot, score: row.score, titles: [...(row.titles ?? [])] }))
    this.tick = tick; this.final = final; this.received = true
    this.version++; this.displayCache = null
  }
  score(robot: number): number | undefined { return this.rows.find(row => row.robot === robot)?.score }
  get hasScores(): boolean { return this.received }
  get ended(): boolean { return this.final }
  display(robots: ReadonlyMap<number, RobotEnt>, self = -1): ScoreDisplay[] {
    // Position/HP changes do not affect the scoreboard. Cache by the bounded
    // per-row visibility/status projection so 64-player HUD frames stay cheap
    // while respawn countdown changes still reach the DOM.
    const stateKey = this.rows.map(row => {
      const robot = robots.get(row.robot)
      const respawn = robot?.respawnInS
      return `${row.robot}:${robot ? (robot.dead ? 'dead' : 'alive') : 'unknown'}:${Number.isFinite(respawn) ? respawn!.toFixed(1) : ''}`
    }).join(';')
    const key = `${this.version}:${self}:${stateKey}`
    if (this.displayCache && this.displayKey === key) return this.displayCache
    const rows = rankedScores(this.rows).map((row, i) => {
      const robot = robots.get(row.robot)
      return { ...row, rank: i + 1,
        nick: this.names.get(row.robot) || `robot-${row.robot}`, self: row.robot === self,
        dead: !!robot?.dead,
        status: (robot ? (robot.dead ? 'dead' : 'alive') : 'unknown') as 'alive' | 'dead' | 'unknown',
        respawnInS: robot?.respawnInS,
      }
    })
    this.displayKey = key
    this.displayCache = rows
    return rows
  }
}

// Criteria mirror server/internal/stats/titles.go. ScoreRow does not carry
// the underlying counters; AOI events cannot reconstruct whole-match totals.
const TITLE_DETAILS: Partial<Record<Title, { name: string; rule: string; metric: string }>> = {
  [Title.WAR_MACHINE]: { name: '战争机器', rule: '击杀次数最多。', metric: '击杀次数' },
  [Title.SCAVENGER]: { name: '垃圾佬', rule: '拾取核心次数最多，并非核心得分最高。', metric: '核心拾取次数' },
  [Title.SIGNAL_THIEF]: { name: '信号大盗', rule: '完成 Uplink 上传次数最多。', metric: '目标贡献（上传次数）' },
  [Title.RUNNER]: { name: '跑路大师', rule: '检查点累计移动距离最长。', metric: '累计移动距离' },
  [Title.WALL_HEAD]: { name: '铁头娃', rule: '记录的撞墙次数最多。', metric: '撞墙次数' },
  [Title.SURVIVOR]: { name: '苟王', rule: '单次连续存活时间最长，并非累计存活时间。', metric: '最长连续存活时长' },
  [Title.PEACEMAKER]: { name: '和平使者', rule: '零击杀，且积分达到全场第 75 百分位；至少两人参赛。', metric: '击杀次数' },
  [Title.AI_IDIOT]: { name: '人工智障', rule: '记录的脚本错误次数最多。', metric: '脚本错误次数' },
  [Title.BARRAGE]: { name: '弹幕大师', rule: '命中次数最多，并非开火次数最多。', metric: '命中次数' },
  [Title.AI_REGULAR]: { name: 'AI 常客', rule: 'AI 对话轮数最多。', metric: 'AI 对话轮数' },
  [Title.OLD_SCHOOL]: { name: '古法编程', rule: '对局结束时在场，未使用 AI 对话，且没有 Snippet 实际接管记录。', metric: 'AI 对话轮数 / Snippet 接管记录' },
  [Title.CNMB]: { name: '充能面包', rule: '死亡次数最多。', metric: '死亡次数' },
  [Title.KILL_STEAL]: { name: '抢人头', rule: '抢人头次数最多：终结者对目标本条生命的伤害占比低于 50%。', metric: '抢人头次数' },
  [Title.HEALER]: { name: '耐活王', rule: '累计有效治疗量最多。', metric: '有效治疗量' },
}

export function titleName(title: number): string {
  return TITLE_DETAILS[title as Title]?.name ?? '' // deprecated/unknown replay values stay hidden
}

export function titleDetails(title: number, score: number, replay?: ReplayTitleEvidence): { name: string; rule: string; evidence: string; source: string } | undefined {
  const detail = TITLE_DETAILS[title as Title]
  if (!detail) return undefined
  const tie = title === Title.PEACEMAKER || title === Title.OLD_SCHOOL ? '' : ' 并列时按先达到该数值者优先，再按机器人编号判定；全场为零不授予。'
  const recorded = title === Title.WAR_MACHINE || title === Title.PEACEMAKER ? replay?.kill
    : title === Title.SCAVENGER ? replay?.core : title === Title.SIGNAL_THIEF ? replay?.uplink
      : title === Title.BARRAGE ? replay?.hit : undefined
  const known = recorded !== undefined && Number.isSafeInteger(recorded) && recorded >= 0
  return { name: detail.name, rule: detail.rule + tie,
    evidence: `${detail.metric}：${known ? `${recorded}（录像已记录）` : '未提供'}；最终积分：${score}。`,
    source: known
      ? '次数来自录像截至当前时刻的事件记录，缺失事件无法补全；不替代服务器完整评选统计。称号与积分来自结算记录，旧录像的规则可能不同。'
      : '称号与积分来自结算记录。当前协议未提供该项统计明细，不从积分或局部事件反推；旧录像的评选规则可能不同。',
  }
}

let nextTitleId = 0
const titleBadges = new WeakMap<HTMLElement, Map<number, HTMLElement>>()

function updateTitleBadge(award: HTMLElement, title: number, score: number, replay?: ReplayTitleEvidence): boolean {
  const info = titleDetails(title, score, replay)
  if (!info) return false
  const button = award.querySelector<HTMLButtonElement>('.score-title')!
  const detail = award.querySelector<HTMLElement>('.score-title-detail')!
  button.textContent = info.name
  button.setAttribute('aria-label', `${info.name}称号`)
  detail.setAttribute('aria-label', `${info.name}称号详情`)
  detail.querySelector<HTMLElement>('.title-rule')!.textContent = info.rule
  detail.querySelector<HTMLElement>('.title-evidence')!.textContent = info.evidence
  detail.querySelector<HTMLElement>('.title-source')!.textContent = info.source
  return true
}

function titleBadge(title: number, score: number, replay?: ReplayTitleEvidence): HTMLElement | undefined {
  const info = titleDetails(title, score, replay)
  if (!info) return undefined
  const award = document.createElement('div'); award.className = 'score-award'; award.dataset.title = String(title)
  const button = document.createElement('button'); button.type = 'button'; button.className = 'score-title'
  button.setAttribute('aria-label', `${info.name}称号`)
  const detail = document.createElement('div'); detail.className = 'score-title-detail'; detail.hidden = true
  detail.id = `score-title-detail-${++nextTitleId}`
  detail.setAttribute('role', 'note')
  detail.setAttribute('aria-label', `${info.name}称号详情`)
  detail.append(text('title-rule', info.rule), text('title-evidence', info.evidence), text('title-source', info.source))
  button.setAttribute('aria-controls', detail.id)
  button.setAttribute('aria-describedby', detail.id)
  button.setAttribute('aria-expanded', 'false')
  button.textContent = info.name
  let hovered = false, focused = false, pinned = false, dismissed = false, touchActivation = false
  const render = () => {
    const open = !dismissed && (hovered || focused || pinned)
    detail.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    award.classList.toggle('is-open', open)
  }
  award.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { hovered = true; dismissed = false; render() } })
  award.addEventListener('pointerleave', () => { hovered = false; render() })
  button.addEventListener('pointerdown', event => { touchActivation = event.pointerType === 'touch' })
  button.addEventListener('focus', () => { focused = true; if (!touchActivation) { dismissed = false; render() } })
  // Preserve an opened disclosure on blur: collapsing inline content during
  // pointerdown can move the next control before its click (e.g. Back to room).
  button.addEventListener('blur', () => { if (focused && !dismissed) pinned = true; focused = false; touchActivation = false; render() })
  button.addEventListener('click', () => { touchActivation = false; pinned = !pinned; dismissed = !pinned; render() })
  button.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); pinned = false; dismissed = true; render()
    }
  })
  award.append(button, detail)
  return award
}

function text(className: string, value: string): HTMLSpanElement {
  const span = document.createElement('span'); span.className = className; span.textContent = value; return span
}

function setClassState(element: HTMLElement, row: ScoreDisplay, ended: boolean): void {
  element.classList.toggle('score-self', row.self)
  element.classList.toggle('score-first', row.rank === 1)
  element.classList.toggle('score-second', row.rank === 2)
  element.classList.toggle('score-third', row.rank === 3)
  const dead = row.dead || row.status === 'dead'
  element.classList.toggle('score-dead', dead)
  element.classList.toggle('score-respawn', dead && Number.isFinite(row.respawnInS) && (row.respawnInS ?? 0) > 0)
  element.classList.toggle('score-alive', row.status === 'alive' && !dead)
  element.classList.toggle('score-unknown', row.status === 'unknown' || row.status === undefined)
  element.dataset.rank = String(row.rank)
  element.dataset.status = row.status ?? (dead ? 'dead' : 'unknown')
  if (ended) element.dataset.status = 'final'
}

function fillScoreRow(element: HTMLElement, row: ScoreDisplay, options: ScoreRowOptions): void {
  setClassState(element, row, !!options.ended)
  const rank = element.querySelector<HTMLElement>('.score-rank')!
  const rankNumber = rank.querySelector<HTMLElement>('.score-rank-number') ?? text('score-rank-number', '')
  if (!rankNumber.parentElement) rank.append(rankNumber)
  const crown = rank.querySelector<SVGSVGElement>('[data-icon="crown"]')
  if (row.rank === 1 && !crown) rank.insertBefore(icon('crown'), rankNumber)
  else if (row.rank !== 1 && crown) crown.remove()
  rankNumber.textContent = String(row.rank)
  element.querySelector<HTMLElement>('.score-name')!.textContent = row.nick
  element.querySelector<HTMLElement>('.score-value')!.textContent = String(row.score)
  const state = element.querySelector<HTMLElement>('.score-state')!
  const stateText = scoreState({ ...row, dead: row.dead || row.status === 'dead' }, !!options.ended)
  state.textContent = stateText
  state.hidden = !stateText
  const evidence = element.querySelector<HTMLElement>('.score-replay-evidence')!
  const recorded = row.replayEvidence
  evidence.hidden = !recorded
  evidence.textContent = recorded ? `K${recorded.kill} H${recorded.hit} C${recorded.core} U${recorded.uplink} A${recorded.assist ?? 0}` : ''

  const badges = element.querySelector<HTMLElement>('.score-titles')!
  badges.hidden = !options.titles
  if (!options.titles) {
    badges.replaceChildren()
    titleBadges.delete(element)
  } else {
    const existing = titleBadges.get(element) ?? new Map<number, HTMLElement>()
    const wanted = new Set((row.titles ?? []).filter(title => titleDetails(title, row.score, row.replayEvidence)))
    for (const [title, badge] of existing) {
      if (!wanted.has(title)) { badge.remove(); existing.delete(title) }
    }
    for (const [index, title] of [...wanted].entries()) {
      let badge = existing.get(title)
      if (!badge) {
        badge = titleBadge(title, row.score, row.replayEvidence)
        if (!badge) continue
        existing.set(title, badge)
      } else updateTitleBadge(badge, title, row.score, row.replayEvidence)
      const current = badges.children[index]
      if (current !== badge) badges.insertBefore(badge, current ?? null)
    }
    if (!wanted.size) {
      let empty = badges.querySelector<HTMLElement>('.score-no-title')
      if (!empty) { empty = text('score-no-title', '暂无称号'); badges.append(empty) }
    } else badges.querySelector('.score-no-title')?.remove()
    titleBadges.set(element, existing)
  }
}

export function scoreRow(row: ScoreDisplay, tag: 'div' | 'li' = 'div', titlesOrOptions: boolean | ScoreRowOptions = false): HTMLElement {
  const options: ScoreRowOptions = typeof titlesOrOptions === 'boolean' ? { titles: titlesOrOptions } : titlesOrOptions
  const element = document.createElement(tag)
  element.className = 'score-row'
  element.dataset.robot = String(row.robot)
  const rank = text('score-rank', '')
  const name = text('score-name', '')
  const value = text('score-value', '')
  const state = text('score-state', '')
  const badges = document.createElement('div'); badges.className = 'score-titles'
  const evidence = text('score-replay-evidence', '')
  evidence.hidden = true
  element.append(rank, name, value, state, evidence, badges)
  fillScoreRow(element, row, options)
  return element
}

/** Keyed DOM renderer: updates rows in place and moves existing nodes only when order changes. */
export class ScoreRowRenderer {
  private readonly rows = new Map<number, HTMLElement>()
  private renderedOptions = ''
  private created = 0
  private moved = 0
  private removed = 0
  update(parent: HTMLElement, values: readonly ScoreDisplay[], options: ScoreRowOptions = {}): void {
    const tag = parent.tagName.toLowerCase() === 'ol' ? 'li' : 'div'
    const wanted = new Set(values.map(value => value.robot))
    for (const empty of [...parent.children]) if (empty.classList.contains('score-waiting')) empty.remove()
    for (const [id, element] of this.rows) {
      if (!wanted.has(id) || element.tagName.toLowerCase() !== tag) {
        element.remove(); this.rows.delete(id); this.removed++
      }
    }
    const key = `${options.titles ? 1 : 0}:${options.ended ? 1 : 0}`
    this.renderedOptions = key
    values.forEach((value, index) => {
      let element = this.rows.get(value.robot)
      if (!element) {
        element = scoreRow(value, tag, options)
        this.rows.set(value.robot, element)
        this.created++
      } else fillScoreRow(element, value, options)
      if (parent.children[index] !== element) {
        parent.insertBefore(element, parent.children[index] ?? null)
        this.moved++
      }
    })
  }
  get nodeCount(): number { return this.rows.size }
  get createdCount(): number { return this.created }
  get movedCount(): number { return this.moved }
  get removedCount(): number { return this.removed }
  clear(): void { this.rows.clear(); this.renderedOptions = '' }
}

export function showMatchEnd(root: HTMLElement, rows: readonly ScoreEntry[], names: ReadonlyMap<number, string>, onBack?: () => void, self = -1): void {
  hideMatchEnd(root)
  const overlay = document.createElement('div'); overlay.className = 'end-overlay'
  overlay.setAttribute('role', 'region'); overlay.setAttribute('aria-label', '对局结算')
  const panel = document.createElement('section'); panel.className = 'end-panel'
  const header = document.createElement('header'); header.className = 'end-header'
  const heading = document.createElement('h2'); heading.className = 'end-title'; heading.textContent = '对局结算'
  header.append(heading, text('end-caption', '战场已关闭，战果已记录'))
  const ranked = rankedScores(rows)
  const ownRank = ranked.findIndex(row => row.robot === self)
  const summary = document.createElement('div'); summary.className = 'end-summary'
  if (ownRank >= 0) {
    const own = ranked[ownRank]!
    summary.append(text('end-placement', `第 ${ownRank + 1} 名`), text('end-personal', `${names.get(self) || `robot-${self}`} · ${own.score} 分`))
  } else summary.append(text('end-placement', '最终战果'))
  summary.append(text('end-field', `${rows.length} 位参赛者`))
  const help = text('end-help', '悬停或聚焦称号查看依据；点击可展开 / 收起，Esc 关闭。')
  const list = document.createElement('ol'); list.className = 'end-list'
  list.setAttribute('aria-label', '最终积分与称号')
  for (const [i, row] of ranked.entries()) {
    list.append(scoreRow({ ...row, rank: i + 1, nick: names.get(row.robot) || `robot-${row.robot}`, self: row.robot === self, dead: false }, 'li', true))
  }
  const footer = document.createElement('footer'); footer.className = 'end-footer'
  footer.append(text('end-source', '积分与称号以服务器结算为准；未提供的统计不作估算。'))
  if (onBack) {
    const back = document.createElement('button'); back.type = 'button'; back.className = 'end-back'
    back.textContent = '回到房间'; back.addEventListener('click', onBack); footer.append(back)
  }
  panel.append(header, summary, help)
  if (!rows.length) panel.append(text('end-empty', '本局无得分记录'))
  else panel.append(list)
  panel.append(footer)
  overlay.append(panel)
  root.append(overlay)
  // A region, not a modal: workbench and room controls remain accessible.
  // Move focus only when the battle canvas owned it, never out of an editor.
  if (document.activeElement?.id === 'game-canvas') { heading.tabIndex = -1; heading.focus({ preventScroll: true }) }
}

export function hideMatchEnd(root: HTMLElement): void {
  for (const element of root.querySelectorAll('.end-overlay')) element.remove()
}
