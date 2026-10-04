import type { EvAiQuota, EvAiUsage } from '@omb/protocol'
import {
  aiHotSwapNotice, aiQuotaText, appendAiStreamText, checkAiPrompt, isAiDirectedSay,
  type AiFeedItem, type AiQuotaState,
} from './ai-assist'
import { escapeHtml } from '../lib/escape'
import './ai-panel.css'

// marked + highlight.js 只服务 AI 面板：动态加载以移出首屏主 chunk（启动时并行
// 拉取；极短的未就绪窗口内退化为转义纯文本，就绪后由构造回调触发重渲染）。
type AiMarkdownModule = typeof import('./ai-markdown')
let markdownModule: AiMarkdownModule | null = null
const markdownReady: Promise<AiMarkdownModule> = import('./ai-markdown').then(module => {
  markdownModule = module
  return module
})

function renderAiMarkdownLazy(source: string, streaming = false): string {
  if (markdownModule) return markdownModule.renderAiMarkdown(source, streaming)
  return escapeHtml(source)
}

export type AiStreamChannel = 'reasoning' | 'answer'

type AiTurnStatus = 'thinking' | 'answering' | 'done' | 'error'

interface AiTurn {
  id: number
  prompt: string
  reasoning: string
  answer: string
  status: AiTurnStatus
  notices: AiFeedItem[]
  dirtyAtSend: boolean
  reasoningScrollTop: number
  reasoningAutoFollow: boolean
  reasoningOpen: boolean
  assistAction: 'ready' | 'active' | 'failed'
}

export interface AiPanelDeps {
  root: HTMLElement
  send: (text: string) => void
  availability: () => { online: boolean; inMatch: boolean }
  editorDirty: () => boolean
  activateAssist: () => boolean
}

export class AiPanelView {
  private pending = false
  private quota?: AiQuotaState
  private turns: AiTurn[] = []
  private nextTurnId = 1
  private nextNoticeId = 1
  private activeTurnId?: number
  private autoFollow = true
  private suppressFollowDetection = false
  private streamRenderTimer?: number
  /** 已渲染 turn 的签名缓存：签名涵盖渲染输出的全部输入，命中即复用 DOM。 */
  private readonly turnCache = new Map<number, { sig: string; el: HTMLElement }>()
  private input!: HTMLTextAreaElement
  private sendButton!: HTMLButtonElement
  private quotaEl!: HTMLElement
  private feedEl!: HTMLElement
  private countEl!: HTMLElement
  private statusEl!: HTMLElement
  private composerStatusEl!: HTMLElement

  constructor(private readonly deps: AiPanelDeps) {
    this.build()
    // 防御：模块在构造后极短时间内才就绪且已有内容时，用完整渲染器重画一次。
    void markdownReady.then(() => { if (this.turns.length) this.render() })
  }

  private build(): void {
    const root = this.deps.root
    root.innerHTML = `
      <header class="ai-heading">
        <div class="ai-core-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="ai-heading-copy">
          <h2>AI 脚本操作员</h2>
          <p>读取当前脚本与战场感知，生成后直接热更</p>
        </div>
        <div class="ai-runtime-status" data-state="idle"><span class="ai-runtime-dot"></span><span class="ai-runtime-label">待命</span></div>
      </header>
      <div class="ai-telemetry">
        <span class="ai-quota" role="status"></span>
        <span class="ai-model-mode">THINKING HIGH · SSE LIVE</span>
      </div>
      <div class="ai-feed" role="log" aria-live="polite" aria-label="AI 对话与生成记录"></div>
      <form class="ai-composer">
        <label for="ai-prompt-input">下达改码指令</label>
        <div class="ai-input-shell">
          <textarea id="ai-prompt-input" rows="3" placeholder="例如：血量低于一半时停止交火，优先寻找最近的医疗包。"></textarea>
          <span class="ai-input-caret" aria-hidden="true"></span>
        </div>
        <div class="ai-composer-meta">
          <span class="ai-composer-status">Ctrl / ⌘ + Enter 发送</span>
          <span class="ai-count"></span>
          <button type="submit" class="primary"><span>执行</span><b aria-hidden="true">↵</b></button>
        </div>
      </form>`
    this.quotaEl = root.querySelector<HTMLElement>('.ai-quota')!
    this.feedEl = root.querySelector<HTMLElement>('.ai-feed')!
    this.input = root.querySelector<HTMLTextAreaElement>('#ai-prompt-input')!
    this.sendButton = root.querySelector<HTMLButtonElement>('.ai-composer button[type=submit]')!
    this.countEl = root.querySelector<HTMLElement>('.ai-count')!
    this.statusEl = root.querySelector<HTMLElement>('.ai-runtime-status')!
    this.composerStatusEl = root.querySelector<HTMLElement>('.ai-composer-status')!
    root.querySelector<HTMLFormElement>('.ai-composer')!.addEventListener('submit', event => {
      event.preventDefault()
      this.submit()
    })
    this.input.addEventListener('input', () => {
      this.renderCount()
      this.composerStatusEl.textContent = 'Ctrl / ⌘ + Enter 发送'
      this.composerStatusEl.dataset.state = ''
    })
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        this.submit()
      }
    })
    this.feedEl.addEventListener('scroll', event => {
      if (this.suppressFollowDetection) return
      const target = event.target as HTMLElement
      if (target.classList.contains('ai-reasoning-body')) {
        const turnElement = target.closest<HTMLElement>('.ai-turn')
        const turn = this.turns.find(item => item.id === Number(turnElement?.dataset.turnId))
        if (turn) {
          turn.reasoningScrollTop = target.scrollTop
          turn.reasoningAutoFollow = target.scrollHeight - target.scrollTop - target.clientHeight < 24
        }
        return
      }
      const distance = this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight
      this.autoFollow = distance < 36
    }, { capture: true, passive: true })
    this.render()
  }

  private submit(): void {
    if (this.pending) return
    const { online, inMatch } = this.deps.availability()
    if (!online || !inMatch) return
    const text = this.input.value.trim()
    const check = checkAiPrompt(text, this.pending)
    if (!check.ok) {
      this.composerStatusEl.textContent = check.reason
      this.composerStatusEl.dataset.state = 'error'
      return
    }
    const turn: AiTurn = {
      id: this.nextTurnId++,
      prompt: text,
      reasoning: '',
      answer: '',
      status: 'thinking',
      notices: [],
      dirtyAtSend: this.deps.editorDirty(),
      reasoningScrollTop: 0,
      reasoningAutoFollow: true,
      reasoningOpen: true,
      assistAction: 'ready',
    }
    this.turns.push(turn)
    this.activeTurnId = turn.id
    this.pending = true
    this.autoFollow = true
    this.input.value = ''
    this.render()
    this.deps.send(text)
  }

  acceptQuota(quota: EvAiQuota | AiQuotaState): void {
    // 快照 60Hz 转发配额（main.ts acceptSelfAiQuota）：值未变时早退，
    // 避免每秒 60 次对象展开 + textContent 无效写。
    const cur = this.quota
    const tokensUsedK = 'tokensUsedK' in quota && quota.tokensUsedK !== undefined ? quota.tokensUsedK : cur?.tokensUsedK
    const tokensLeftK = 'tokensLeftK' in quota && quota.tokensLeftK !== undefined ? quota.tokensLeftK : cur?.tokensLeftK
    const globalTokensLeftK = 'globalTokensLeftK' in quota && quota.globalTokensLeftK !== undefined ? quota.globalTokensLeftK : cur?.globalTokensLeftK
    if (cur && cur.roundsLeft === quota.roundsLeft && cur.tokensUsedK === tokensUsedK &&
        cur.tokensLeftK === tokensLeftK && cur.globalTokensLeftK === globalTokensLeftK) return
    this.quota = { roundsLeft: quota.roundsLeft, tokensUsedK, tokensLeftK, globalTokensLeftK }
    this.renderQuota()
  }

  acceptUsage(usage: EvAiUsage): void {
    if (!this.quota) return
    this.quota.globalTokensLeftK = usage.globalLeftK
    this.renderQuota()
  }

  acceptDirectedSay(text: string): boolean {
    if (!isAiDirectedSay(text, this.pending)) return false
    const isError = text.startsWith('AI 请求失败：') || text.startsWith('AI 生成脚本编译失败') || text.startsWith('AI 改码未生效') || text.startsWith('AI 未启用')
    const turn = this.currentTurn()
    if (turn) {
      turn.notices.push({ id: this.nextNoticeId++, kind: isError ? 'error' : 'info', text })
      if (isError) turn.status = 'error'
    }
    if (isError) {
      this.pending = false
      this.activeTurnId = undefined
    }
    this.render()
    return true
  }

  acceptStream(channel: AiStreamChannel, delta: string): void {
    if (!this.pending || !delta) return
    const turn = this.activeTurn()
    if (!turn) return
    const needsStructure = channel === 'reasoning'
      ? !this.feedEl.querySelector(`.ai-turn[data-turn-id="${turn.id}"] .ai-reasoning-body`)
      : !this.feedEl.querySelector(`.ai-turn[data-turn-id="${turn.id}"] .ai-answer-body`)
    if (channel === 'reasoning') {
      turn.reasoning = appendAiStreamText(turn.reasoning, delta)
    } else {
      turn.answer = appendAiStreamText(turn.answer, delta)
      turn.status = 'answering'
    }
    if (needsStructure) this.renderFeed()
    else this.scheduleStreamRender()
    this.renderRuntimeStatus()
  }

  acceptHotSwap(): void {
    if (!this.pending) return
    const turn = this.activeTurn()
    if (turn) {
      turn.status = 'done'
      turn.assistAction = 'ready'
      turn.notices.push({ id: this.nextNoticeId++, kind: 'success', text: aiHotSwapNotice(turn.dirtyAtSend) })
    }
    this.pending = false
    this.activeTurnId = undefined
    this.render()
  }

  markOffline(): void {
    this.failActive('连接中断，AI 结果未知；恢复后可重新发送。')
  }

  markMatchEnded(): void {
    this.failActive('对局已切换，AI 结果未知。')
  }

  resetSession(_reason: 'identity' | 'match'): void {
    this.pending = false
    this.activeTurnId = undefined
    this.turns = []
    this.quota = undefined
    this.autoFollow = true
    this.render()
  }

  private failActive(text: string): void {
    if (!this.pending) return
    const turn = this.activeTurn()
    if (turn) {
      turn.status = 'error'
      turn.notices.push({ id: this.nextNoticeId++, kind: 'error', text })
    }
    this.pending = false
    this.activeTurnId = undefined
    this.render()
  }

  private activeTurn(): AiTurn | undefined {
    return this.turns.find(turn => turn.id === this.activeTurnId)
  }

  private currentTurn(): AiTurn | undefined {
    return this.activeTurn() ?? this.turns.at(-1)
  }

  private renderQuota(): void {
    this.quotaEl.textContent = aiQuotaText(this.quota)
  }

  private scheduleStreamRender(): void {
    if (this.streamRenderTimer !== undefined) return
    // 流式渲染对累积全文重跑 markdown+高亮，代价随文本增长：150ms 合帧
    // （50ms 时长回答打字期呈 O(n²) 主线程占用，肉眼流畅度无差）。
    this.streamRenderTimer = window.setTimeout(() => {
      this.streamRenderTimer = undefined
      this.updateLiveTurn()
    }, 150)
  }

  private updateLiveTurn(): void {
    const turn = this.activeTurn()
    if (!turn) return
    const article = this.feedEl.querySelector<HTMLElement>(`.ai-turn[data-turn-id="${turn.id}"]`)
    if (!article) {
      this.renderFeed()
      return
    }
    const reasoningBody = article.querySelector<HTMLElement>('.ai-reasoning-body')
    if (reasoningBody && turn.reasoning) {
      const scrollTop = reasoningBody.scrollTop
      reasoningBody.innerHTML = renderAiMarkdownLazy(turn.reasoning, !turn.answer)
      reasoningBody.scrollTop = turn.reasoningAutoFollow ? reasoningBody.scrollHeight : scrollTop
    }
    const answerBody = article.querySelector<HTMLElement>('.ai-answer-body')
    if (answerBody && turn.answer) {
      answerBody.innerHTML = renderAiMarkdownLazy(turn.answer, true)
    }
    this.followAfterStreamUpdate(turn)
  }

  private followAfterStreamUpdate(turn: AiTurn): void {
    this.suppressFollowDetection = true
    if (this.autoFollow) this.feedEl.scrollTop = this.feedEl.scrollHeight
    const article = this.feedEl.querySelector<HTMLElement>(`.ai-turn[data-turn-id="${turn.id}"]`)
    const reasoningBody = article?.querySelector<HTMLElement>('.ai-reasoning-body')
    if (reasoningBody) reasoningBody.scrollTop = turn.reasoningAutoFollow ? reasoningBody.scrollHeight : turn.reasoningScrollTop
    article?.querySelectorAll<HTMLElement>('.ai-code-frame pre').forEach(pre => { pre.scrollTop = pre.scrollHeight })
    requestAnimationFrame(() => { this.suppressFollowDetection = false })
  }

  private renderFeed(): void {
    const shouldFollow = this.autoFollow
    for (const turn of this.turns) {
      const body = this.feedEl.querySelector<HTMLElement>(`.ai-turn[data-turn-id="${turn.id}"] .ai-reasoning-body`)
      if (body) {
        turn.reasoningScrollTop = body.scrollTop
        turn.reasoningAutoFollow = body.scrollHeight - body.scrollTop - body.clientHeight < 24
        turn.reasoningOpen = this.feedEl.querySelector<HTMLDetailsElement>(`.ai-turn[data-turn-id="${turn.id}"] .ai-reasoning`)?.open ?? turn.reasoningOpen
      }
    }
    if (shouldFollow || this.turns.some(turn => turn.reasoningAutoFollow)) this.suppressFollowDetection = true
    // 只重建签名变化的 turn：历史回合的内容不可变，避免每次 render 都对
    // 全部历史重复 marked.parse + hljs 高亮（setAvailability/流式都会触发 render）。
    const alive = new Set(this.turns.map(turn => turn.id))
    for (const id of this.turnCache.keys()) if (!alive.has(id)) this.turnCache.delete(id)
    const fragment = document.createDocumentFragment()
    if (!this.turns.length) {
      const empty = document.createElement('section')
      empty.className = 'ai-empty-state'
      empty.innerHTML = `<div class="ai-empty-scope" aria-hidden="true"><span></span><span></span><span></span></div><h3>等待脚本任务</h3><p>描述你想改变的战术。AI 会展示思考过程、生成说明与完整高亮代码，然后热更当前机器人。</p>`
      fragment.append(empty)
    }
    for (const turn of this.turns) {
      const sig = this.turnSig(turn)
      const cached = this.turnCache.get(turn.id)
      if (cached && cached.sig === sig) {
        fragment.append(cached.el)
        continue
      }
      const el = this.renderTurn(turn)
      this.turnCache.set(turn.id, { sig, el })
      fragment.append(el)
    }
    this.feedEl.replaceChildren(fragment)
    requestAnimationFrame(() => {
      if (shouldFollow) {
        this.feedEl.scrollTop = this.feedEl.scrollHeight
        this.autoFollow = true
      }
      const liveTurn = this.feedEl.querySelector<HTMLElement>('.ai-turn[data-live="true"]')
      liveTurn?.querySelectorAll<HTMLElement>('.ai-code-frame pre').forEach(pre => { pre.scrollTop = pre.scrollHeight })
      for (const turn of this.turns) {
        const body = this.feedEl.querySelector<HTMLElement>(`.ai-turn[data-turn-id="${turn.id}"] .ai-reasoning-body`)
        if (!body) continue
        body.scrollTop = turn.reasoningAutoFollow ? body.scrollHeight : turn.reasoningScrollTop
      }
      requestAnimationFrame(() => { this.suppressFollowDetection = false })
    })
  }

  /** 渲染输出的全部输入决定签名：状态、两段文本长度、通知数、辅助动作与 live 位。 */
  private turnSig(turn: AiTurn): string {
    return [
      turn.status,
      turn.prompt,
      turn.reasoning.length,
      turn.answer.length,
      turn.notices.length,
      turn.assistAction,
      String(this.pending && turn.id === this.activeTurnId),
    ].join('\u0000')
  }

  private renderTurn(turn: AiTurn): HTMLElement {
    const article = document.createElement('article')
    article.className = 'ai-turn'
    article.dataset.turnId = String(turn.id)
    article.dataset.state = turn.status
    article.dataset.live = String(this.pending && turn.id === this.activeTurnId)

    const user = document.createElement('section')
    user.className = 'ai-message ai-message-user'
    const userMeta = document.createElement('div')
    userMeta.className = 'ai-message-meta'
    userMeta.innerHTML = '<span>PLAYER INPUT</span><i></i>'
    const userText = document.createElement('p')
    userText.textContent = turn.prompt
    user.append(userMeta, userText)

    const assistant = document.createElement('section')
    assistant.className = 'ai-message ai-message-assistant'
    const assistantMeta = document.createElement('div')
    assistantMeta.className = 'ai-message-meta'
    const phase = turn.status === 'thinking' ? '正在推理' : turn.status === 'answering' ? '正在生成' : turn.status === 'done' ? '任务完成' : '任务中断'
    assistantMeta.innerHTML = `<span>OMB AI</span><b>${phase}</b>`
    assistant.append(assistantMeta)
    if (turn.status === 'thinking') assistant.append(this.renderGenerator())

    if (turn.reasoning) {
      const reasoning = document.createElement('details')
      reasoning.className = 'ai-reasoning'
      reasoning.open = turn.reasoningOpen
      reasoning.addEventListener('toggle', () => { turn.reasoningOpen = reasoning.open })
      const summary = document.createElement('summary')
      summary.innerHTML = '<span class="ai-reasoning-signal" aria-hidden="true"></span><span>思考过程</span><i>点击收起</i>'
      const body = document.createElement('div')
      body.className = 'ai-markdown ai-reasoning-body'
      body.innerHTML = renderAiMarkdownLazy(turn.reasoning, this.pending && turn.id === this.activeTurnId && !turn.answer)
      reasoning.append(summary, body)
      assistant.append(reasoning)
    }

    if (turn.answer) {
      const answer = document.createElement('div')
      answer.className = 'ai-markdown ai-answer-body'
      answer.innerHTML = renderAiMarkdownLazy(turn.answer, this.pending && turn.id === this.activeTurnId)
      assistant.append(answer)
    }

    if (turn.status === 'done' && turn.assistAction === 'ready') {
      const action = document.createElement('div')
      action.className = 'ai-apply-action'
      action.innerHTML = '<div class="ai-apply-copy"><strong>脚本已应用到 Bot</strong><span>要立即交给驾驶辅助接管吗？</span></div><button type="button" class="ai-apply-button"><span>应用到 Bot 并激活驾驶辅助</span><b aria-hidden="true">→</b></button>'
      action.querySelector<HTMLButtonElement>('.ai-apply-button')!.addEventListener('click', () => this.activateAssist(turn.id))
      assistant.append(action)
    }

    for (const notice of turn.notices) {
      const line = document.createElement('div')
      line.className = `ai-turn-notice kind-${notice.kind}`
      line.textContent = notice.text
      assistant.append(line)
    }

    article.append(user, assistant)
    return article
  }

  private activateAssist(turnId: number): void {
    const turn = this.turns.find(item => item.id === turnId)
    if (!turn || turn.assistAction !== 'ready') return
    if (!this.deps.activateAssist()) {
      turn.assistAction = 'failed'
      turn.notices.push({ id: this.nextNoticeId++, kind: 'error', text: '当前战场尚未就绪，请回到游戏视图后重试。' })
    } else {
      turn.assistAction = 'active'
      turn.notices.push({ id: this.nextNoticeId++, kind: 'success', text: '驾驶辅助已激活，当前脚本正在接管 Bot。' })
    }
    this.render()
  }

  private renderGenerator(): HTMLElement {
    const generator = document.createElement('div')
    generator.className = 'ai-generator'
    generator.setAttribute('role', 'status')
    generator.innerHTML = `<div class="ai-generator-signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div class="ai-generator-copy"><strong>正在构建行动方案</strong><span>解析脚本 <b>·</b> 对照 Bot API <b>·</b> 规划热更</span></div><div class="ai-generator-meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>`
    return generator
  }

  private renderCount(): void {
    this.countEl.textContent = `${[...this.input.value].length} 字`
  }

  private renderRuntimeStatus(): void {
    const { online, inMatch } = this.deps.availability()
    let state = 'idle'
    let label = '待命'
    const turn = this.activeTurn()
    if (!online) { state = 'offline'; label = '离线' }
    else if (!inMatch) { state = 'blocked'; label = '等待对局' }
    else if (this.pending) {
      state = turn?.status === 'answering' ? 'writing' : 'thinking'
      label = state === 'writing' ? '生成代码' : '深度思考'
    }
    this.statusEl.dataset.state = state
    this.statusEl.querySelector<HTMLElement>('.ai-runtime-label')!.textContent = label
  }

  render(): void {
    const { online, inMatch } = this.deps.availability()
    this.sendButton.disabled = this.pending || !online || !inMatch
    this.sendButton.querySelector('span')!.textContent = this.pending ? '执行中' : '执行'
    this.sendButton.title = !online ? '连接恢复后可发送' : !inMatch ? '进入热身或正式对局后可发送' : this.pending ? '等待当前任务完成' : '发送给 AI 脚本操作员'
    this.input.disabled = this.pending
    this.renderCount()
    this.renderQuota()
    this.renderRuntimeStatus()
    this.renderFeed()
  }

  focus(): void {
    this.input.focus({ preventScroll: true })
  }
}
