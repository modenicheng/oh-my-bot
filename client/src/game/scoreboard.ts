import { Title } from '@omb/protocol'
import type { RobotEnt } from './world'
import { icon } from '../icons'
import { setText } from '../ui/dom'
import './scoreboard.css'

export interface ScoreEntry { robot: number; score: number; titles?: readonly number[]; nick?: string }
export interface ReplayTitleEvidence { kill: number; hit: number; core: number; uplink: number; assist?: number }
export interface ScoreDisplay extends ScoreEntry { rank: number; nick: string; self: boolean; dead: boolean; status?: 'alive' | 'dead' | 'unknown'; replayEvidence?: ReplayTitleEvidence }

export type ScoreRowOptions = { titles?: boolean; ended?: boolean }

function sameScore(a: ScoreEntry, b: ScoreEntry): boolean {
  const titles = a.titles ?? [], previous = b.titles ?? []
  return a.robot === b.robot && a.score === b.score && (a.nick ?? '') === (b.nick ?? '') && titles.length === previous.length
    && titles.every((title, index) => title === previous[index])
}

function sameDisplay(a: ScoreDisplay, b: ScoreDisplay): boolean {
  const evidence = a.replayEvidence, previous = b.replayEvidence
  return sameScore(a, b) && a.rank === b.rank && a.nick === b.nick && a.self === b.self
    && a.dead === b.dead && a.status === b.status
    && (evidence === undefined || previous === undefined ? evidence === previous
      : evidence.kill === previous.kill && evidence.hit === previous.hit && evidence.core === previous.core
        && evidence.uplink === previous.uplink && evidence.assist === previous.assist)
}

export function rankedScores<T extends ScoreEntry>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.robot - b.robot)
}

/** Global rows carry identity independently of AOI; old servers can use observed names. */
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
    const changed = !this.received || final !== this.final || rows.length !== this.rows.length
      || rows.some((row, index) => !sameScore(row, this.rows[index]!))
    // Identical snapshots still advance freshness; they must not invalidate the HUD.
    this.tick = tick; this.final = final; this.received = true
    if (!changed) return
    this.rows = rows.map(row => ({ robot: row.robot, score: row.score, titles: [...(row.titles ?? [])], nick: row.nick }))
    for (const row of rows) if (row.nick) this.names.set(row.robot, row.nick)
    this.version++; this.displayCache = null
  }
  score(robot: number): number | undefined { return this.rows.find(row => row.robot === robot)?.score }
  get hasScores(): boolean { return this.received }
  get ended(): boolean { return this.final }
  display(robots: ReadonlyMap<number, RobotEnt>, self = -1): ScoreDisplay[] {
    // Position/HP/respawn countdown changes do not affect the compact scoreboard.
    // Cache by the bounded per-row visibility/status projection so 64-player HUD
    // frames stay cheap.
    const stateKey = this.rows.map(row => {
      const robot = robots.get(row.robot)
      return `${row.robot}:${robot ? (robot.dead ? 'dead' : 'alive') : 'unknown'}`
    }).join(';')
    const key = `${this.version}:${self}:${stateKey}`
    if (this.displayCache && this.displayKey === key) return this.displayCache
    const rows = rankedScores(this.rows).map((row, i) => {
      const robot = robots.get(row.robot)
      return { ...row, rank: i + 1,
        nick: row.nick || this.names.get(row.robot) || `robot-${row.robot}`, self: row.robot === self,
        dead: !!robot?.dead,
        status: (robot ? (robot.dead ? 'dead' : 'alive') : 'unknown') as 'alive' | 'dead' | 'unknown',
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
const titleDetailsByAward = new WeakMap<HTMLElement, HTMLElement>()
const titleCleanupByAward = new WeakMap<HTMLElement, () => void>()

function positionTitleDetail(button: HTMLElement, detail: HTMLElement): void {
  const margin = 12, gap = 6
  detail.style.maxHeight = `${Math.max(120, window.innerHeight - margin * 2)}px`
  detail.style.left = `${margin}px`
  detail.style.top = `${margin}px`
  const anchor = button.getBoundingClientRect()
  const popup = detail.getBoundingClientRect()
  const maxLeft = Math.max(margin, window.innerWidth - popup.width - margin)
  const left = Math.min(Math.max(anchor.left, margin), maxLeft)
  const below = anchor.bottom + gap
  const above = anchor.top - popup.height - gap
  const top = below + popup.height <= window.innerHeight - margin ? below : Math.max(margin, above)
  detail.style.left = `${Math.round(left)}px`
  detail.style.top = `${Math.round(top)}px`
}

function disposeTitleBadge(award: HTMLElement): void {
  titleCleanupByAward.get(award)?.()
  titleCleanupByAward.delete(award)
  titleDetailsByAward.delete(award)
}

function disposeRowTitles(element: HTMLElement): void {
  for (const award of element.querySelectorAll<HTMLElement>('.score-award')) disposeTitleBadge(award)
  titleBadges.delete(element)
}

function updateTitleBadge(award: HTMLElement, title: number, score: number, replay?: ReplayTitleEvidence): boolean {
  const info = titleDetails(title, score, replay)
  if (!info) return false
  const button = award.querySelector<HTMLButtonElement>('.score-title')!
  const detail = titleDetailsByAward.get(award)
  if (!detail) return false
  setText(button, info.name)
  if (button.getAttribute('aria-label') !== `${info.name}称号`) button.setAttribute('aria-label', `${info.name}称号`)
  if (detail.getAttribute('aria-label') !== `${info.name}称号详情`) detail.setAttribute('aria-label', `${info.name}称号详情`)
  setText(detail.querySelector<HTMLElement>('.title-rule')!, info.rule)
  setText(detail.querySelector<HTMLElement>('.title-evidence')!, info.evidence)
  setText(detail.querySelector<HTMLElement>('.title-source')!, info.source)
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
  let triggerHovered = false, detailHovered = false, focused = false, pinned = false, dismissed = false, touchActivation = false
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const onViewportChange = () => { if (!detail.hidden) positionTitleDetail(button, detail) }
  const render = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined }
    const open = !dismissed && (triggerHovered || detailHovered || focused || pinned)
    detail.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    award.classList.toggle('is-open', open)
    if (open) {
      positionTitleDetail(button, detail)
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
    } else {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }
  const renderSoon = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(render, 80)
  }
  award.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { triggerHovered = true; dismissed = false; render() } })
  award.addEventListener('pointerleave', () => { triggerHovered = false; renderSoon() })
  detail.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { detailHovered = true; dismissed = false; render() } })
  detail.addEventListener('pointerleave', () => { detailHovered = false; renderSoon() })
  button.addEventListener('pointerdown', event => { touchActivation = event.pointerType === 'touch' })
  button.addEventListener('focus', () => { focused = true; if (!touchActivation) { dismissed = false; render() } })
  button.addEventListener('blur', () => { focused = false; touchActivation = false; renderSoon() })
  button.addEventListener('click', () => { touchActivation = false; pinned = !pinned; dismissed = !pinned; render() })
  button.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); pinned = false; dismissed = true; render()
    }
  })
  award.append(button)
  document.body.append(detail)
  titleDetailsByAward.set(award, detail)
  titleCleanupByAward.set(award, () => {
    if (closeTimer) clearTimeout(closeTimer)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
    detail.remove()
  })
  return award
}

function text(className: string, value: string): HTMLSpanElement {
  const span = document.createElement('span'); span.className = className; span.textContent = value; return span
}

function toggleClass(element: HTMLElement, name: string, enabled: boolean): void {
  if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled)
}

function setClassState(element: HTMLElement, row: ScoreDisplay, ended: boolean): void {
  toggleClass(element, 'score-self', row.self)
  toggleClass(element, 'score-first', row.rank === 1)
  toggleClass(element, 'score-second', row.rank === 2)
  toggleClass(element, 'score-third', row.rank === 3)
  const dead = row.dead || row.status === 'dead'
  toggleClass(element, 'score-dead', dead)
  const rank = String(row.rank), status = ended ? 'final' : row.status ?? (dead ? 'dead' : 'unknown')
  if (element.dataset.rank !== rank) element.dataset.rank = rank
  if (element.dataset.status !== status) element.dataset.status = status
}

function fillScoreRow(element: HTMLElement, row: ScoreDisplay, options: ScoreRowOptions): void {
  setClassState(element, row, !!options.ended)
  const rank = element.querySelector<HTMLElement>('.score-rank')!
  const rankNumber = rank.querySelector<HTMLElement>('.score-rank-number') ?? text('score-rank-number', '')
  if (!rankNumber.parentElement) rank.append(rankNumber)
  const crown = rank.querySelector<SVGSVGElement>('[data-icon="crown"]')
  if (row.rank === 1 && !crown) rank.insertBefore(icon('crown'), rankNumber)
  else if (row.rank !== 1 && crown) crown.remove()
  setText(rankNumber, String(row.rank))
  setText(element.querySelector<HTMLElement>('.score-name')!, row.nick)
  setText(element.querySelector<HTMLElement>('.score-value')!, String(row.score))
  const evidence = element.querySelector<HTMLElement>('.score-replay-evidence')!
  const recorded = row.replayEvidence
  if (evidence.hidden !== !recorded) evidence.hidden = !recorded
  setText(evidence, recorded ? `K${recorded.kill} H${recorded.hit} C${recorded.core} U${recorded.uplink} A${recorded.assist ?? 0}` : '')

  const badges = element.querySelector<HTMLElement>('.score-titles')!
  if (badges.hidden !== !options.titles) badges.hidden = !options.titles
  if (!options.titles) {
    if (badges.childNodes.length) {
      disposeRowTitles(element)
      badges.replaceChildren()
    }
  } else {
    const existing = titleBadges.get(element) ?? new Map<number, HTMLElement>()
    const wanted = new Set((row.titles ?? []).filter(title => titleDetails(title, row.score, row.replayEvidence)))
    for (const [title, badge] of existing) {
      if (!wanted.has(title)) { disposeTitleBadge(badge); badge.remove(); existing.delete(title) }
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
  const badges = document.createElement('div'); badges.className = 'score-titles'
  const evidence = text('score-replay-evidence', '')
  evidence.hidden = true
  element.append(rank, name, value, evidence, badges)
  fillScoreRow(element, row, options)
  return element
}

/** Find the rows that can stay attached while the changed order is applied. */
function stationaryRows(positions: number[]): Set<number> {
  const tails: number[] = [], previous = new Array<number>(positions.length).fill(-1)
  for (let i = 0; i < positions.length; i++) {
    if (positions[i]! < 0) continue
    let low = 0, high = tails.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (positions[tails[mid]!]! < positions[i]!) low = mid + 1
      else high = mid
    }
    if (low > 0) previous[i] = tails[low - 1]!
    tails[low] = i
  }
  const stable = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) stable.add(i)
  return stable
}

/** Keyed DOM renderer: update leaves in place and move the fewest row nodes. */
export class ScoreRowRenderer {
  private readonly rows = new Map<number, HTMLElement>()
  private readonly renderedRows = new Map<number, ScoreDisplay>()
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
        disposeRowTitles(element); element.remove(); this.rows.delete(id); this.removed++
        this.renderedRows.delete(id)
      }
    }
    const key = `${options.titles ? 1 : 0}:${options.ended ? 1 : 0}`
    const optionsChanged = this.renderedOptions !== key
    this.renderedOptions = key
    const elements = values.map(value => {
      let element = this.rows.get(value.robot)
      const previous = this.renderedRows.get(value.robot)
      const changed = optionsChanged || !previous || !sameDisplay(value, previous)
      if (!element) {
        element = scoreRow(value, tag, options)
        this.rows.set(value.robot, element)
        this.created++
      } else if (changed) fillScoreRow(element, value, options)
      if (changed) {
        // Replay callers can mutate and reuse row objects; keep a value snapshot.
        this.renderedRows.set(value.robot, { ...value, titles: value.titles && [...value.titles],
          replayEvidence: value.replayEvidence && { ...value.replayEvidence } })
      }
      return element
    })
    const current = [...parent.children]
    if (current.length === elements.length && current.every((element, index) => element === elements[index])) return
    const positions = new Map(current.map((element, index) => [element, index]))
    const stable = stationaryRows(elements.map(element => positions.get(element) ?? -1))
    // Forward insertion moves 63 siblings when the leader falls to last place.
    // The longest increasing subsequence stays attached to reduce accessible subtree churn.
    for (let i = elements.length - 1; i >= 0; i--) if (!stable.has(i)) {
      const element = elements[i]!, next = elements[i + 1] ?? null
      // An attached row may own focus or an open title. Preserve that state on
      // browsers supporting atomic moves; new rows still use ordinary insertion.
      if (parent.isConnected && element.parentElement === parent && typeof parent.moveBefore === 'function') {
        parent.moveBefore(element, next)
      } else parent.insertBefore(element, next)
      this.moved++
    }
  }
  get nodeCount(): number { return this.rows.size }
  get createdCount(): number { return this.created }
  get movedCount(): number { return this.moved }
  get removedCount(): number { return this.removed }
  clear(): void { for (const element of this.rows.values()) disposeRowTitles(element); this.rows.clear(); this.renderedRows.clear(); this.renderedOptions = '' }
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
    summary.append(text('end-placement', `第 ${ownRank + 1} 名`), text('end-personal', `${own.nick || names.get(self) || `robot-${self}`} · ${own.score} 分`))
  } else summary.append(text('end-placement', '最终战果'))
  summary.append(text('end-field', `${rows.length} 位参赛者`))
  const help = text('end-help', '悬停或聚焦称号即可浮动查看依据；点击可固定，Esc 关闭。')
  const list = document.createElement('ol'); list.className = 'end-list'
  list.setAttribute('aria-label', '最终积分与称号')
  for (const [i, row] of ranked.entries()) {
    list.append(scoreRow({ ...row, rank: i + 1, nick: row.nick || names.get(row.robot) || `robot-${row.robot}`, self: row.robot === self, dead: false }, 'li', true))
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
  for (const element of root.querySelectorAll<HTMLElement>('.end-overlay')) { disposeRowTitles(element); element.remove() }
}
