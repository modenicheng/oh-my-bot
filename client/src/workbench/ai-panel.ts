// AI 助手面板：自然语言指令 → AiPrompt 上行；单玩家串行 pending；
// 配额（EvAiQuota/usage 回执 + 快照 SelfState）与 robot=0 定向说明展示。
// 编辑器安全策略：ScriptResult(client_script_id=0) 成功后提示“已热更、
// 草稿未自动覆盖”，绝不伪造源码。
import type { EvAiQuota, EvAiUsage } from '@omb/protocol'
import {
  AI_MAX_PROMPT_CHARS, aiHotSwapNotice, aiQuotaText, checkAiPrompt, isAiDirectedSay,
  type AiFeedItem, type AiQuotaState,
} from './ai-assist'

export interface AiPanelDeps {
  root: HTMLElement
  /** 发送 prompt 文本；宿主负责编码与在线守卫。 */
  send: (text: string) => void
  availability: () => { online: boolean; inMatch: boolean }
  /** 发送 AI 请求时编辑器草稿是否脏（成功后提示文案分支）。 */
  editorDirty: () => boolean
}

export class AiPanelView {
  private pending = false
  private quota?: AiQuotaState
  private feed: AiFeedItem[] = []
  private nextFeedId = 1
  private wasDirtyAtSend = false
  private identity = ''
  private input!: HTMLTextAreaElement
  private sendButton!: HTMLButtonElement
  private quotaEl!: HTMLElement
  private feedEl!: HTMLElement
  private countEl!: HTMLElement

  constructor(private readonly deps: AiPanelDeps) {
    this.build()
  }

  private build(): void {
    const root = this.deps.root
    root.innerHTML = `
      <header class="workbench-heading">
        <h2>AI 助手</h2>
      </header>
      <div class="ai-quota" role="status"></div>
      <div class="ai-feed" role="log" aria-live="polite" aria-label="AI 回执与说明"></div>
      <form class="ai-composer">
        <label class="sr-only" for="ai-prompt-input">AI 指令</label>
        <textarea id="ai-prompt-input" rows="3" placeholder="用自然语言描述要怎么改（如：血量低于一半就绕着最近的核心跑）"></textarea>
        <div class="ai-composer-meta">
          <span class="ai-count"></span>
          <button type="submit" class="primary">发送</button>
        </div>
      </form>`
    this.quotaEl = root.querySelector<HTMLElement>('.ai-quota')!
    this.feedEl = root.querySelector<HTMLElement>('.ai-feed')!
    this.input = root.querySelector<HTMLTextAreaElement>('#ai-prompt-input')!
    this.sendButton = root.querySelector<HTMLButtonElement>('.ai-composer button[type=submit]')!
    this.countEl = root.querySelector<HTMLElement>('.ai-count')!
    root.querySelector<HTMLFormElement>('.ai-composer')!.addEventListener('submit', event => {
      event.preventDefault()
      this.submit()
    })
    this.input.addEventListener('input', () => this.renderCount())
    this.render()
  }

  private submit(): void {
    if (this.pending) return
    const { online, inMatch } = this.deps.availability()
    if (!online || !inMatch) return
    const text = this.input.value.replace(/[\s\u0000-\u001f]+/g, ' ').trim()
    const check = checkAiPrompt(text, this.pending)
    if (!check.ok) {
      this.push('error', check.reason)
      return
    }
    this.pending = true
    this.wasDirtyAtSend = this.deps.editorDirty()
    this.push('info', 'AI 正在处理（数秒到数十秒），完成后在此显示结果。')
    this.input.value = ''
    this.render()
    this.deps.send(text)
  }

  /** 配额事实：EvAiQuota 定向回执或快照 SelfState 初始值。 */
  acceptQuota(quota: EvAiQuota | AiQuotaState): void {
    const next: AiQuotaState = { ...this.quota, roundsLeft: quota.roundsLeft }
    if ('tokensUsedK' in quota && quota.tokensUsedK !== undefined) next.tokensUsedK = quota.tokensUsedK
    if ('tokensLeftK' in quota && quota.tokensLeftK !== undefined) next.tokensLeftK = quota.tokensLeftK
    if ('globalTokensLeftK' in quota && quota.globalTokensLeftK !== undefined) next.globalTokensLeftK = quota.globalTokensLeftK
    this.quota = next
    this.renderQuota()
  }

  /** EvAiUsage 是公开计量事件；定向 EvAiQuota 才是个人配额权威值。 */
  acceptUsage(usage: EvAiUsage): void {
    if (this.quota) {
      this.quota.globalTokensLeftK = usage.globalLeftK
      this.renderQuota()
    }
  }

  /**
   * robot=0 定向说明：仅 pending 时消费（isAiDirectedSay 判定前缀）。
   * 返回是否已消费——未消费的说明仍走游戏/系统通道。
   */
  acceptDirectedSay(text: string): boolean {
    if (!isAiDirectedSay(text, this.pending)) return false
    const isError = text.startsWith('AI 请求失败：') || text.startsWith('AI 生成脚本编译失败') || text.startsWith('AI 改码未生效') || text.startsWith('AI 未启用')
    this.push(isError ? 'error' : 'info', text)
    if (isError) this.pending = false
    this.render()
    return true
  }

  /** AI 改码成功热更（ScriptResult client_script_id=0，ok=true）。 */
  acceptHotSwap(): void {
    if (!this.pending) return
    this.pending = false
    this.push('success', aiHotSwapNotice(this.wasDirtyAtSend))
    this.render()
  }

  /** 断线：pending 落为未知（重连后由配额/说明回执恢复事实）。 */
  markOffline(): void {
    if (this.pending) {
      this.pending = false
      this.push('error', '连接中断，AI 结果未知；恢复后可重新发送。')
      this.render()
    }
  }

  markMatchEnded(): void {
    if (this.pending) {
      this.pending = false
      this.push('error', '对局已切换，AI 结果未知。')
      this.render()
    }
  }

  /** 身份/对局切换：清空消息流与 pending（配额由新对局回执刷新）。 */
  resetSession(_reason: 'identity' | 'match'): void {
    this.pending = false
    this.feed = []
    this.quota = undefined
    this.render()
  }

  private push(kind: AiFeedItem['kind'], text: string): void {
    this.feed.push({ id: this.nextFeedId++, kind, text })
    if (this.feed.length > 50) this.feed.splice(0, this.feed.length - 50)
    this.renderFeed()
  }

  private renderQuota(): void {
    this.quotaEl.textContent = aiQuotaText(this.quota)
  }

  private renderFeed(): void {
    const fragment = document.createDocumentFragment()
    if (!this.feed.length) {
      const empty = document.createElement('div')
      empty.className = 'ai-feed-empty'
      empty.textContent = 'AI 会读取你当前的脚本与感知数据，改完自动热更（配额内）。'
      fragment.append(empty)
    }
    for (const item of [...this.feed].reverse()) {
      const line = document.createElement('div')
      line.className = `ai-feed-item kind-${item.kind}`
      line.textContent = item.text
      fragment.append(line)
    }
    this.feedEl.replaceChildren(fragment)
  }

  private renderCount(): void {
    this.countEl.textContent = `${[...this.input.value].length}/${AI_MAX_PROMPT_CHARS}`
  }

  render(): void {
    const { online, inMatch } = this.deps.availability()
    this.sendButton.disabled = this.pending || !online || !inMatch
    this.sendButton.textContent = this.pending ? '处理中…' : '发送'
    this.sendButton.title = !online ? '连接恢复后可发送' : !inMatch ? '进入热身或正式对局后可发送' : this.pending ? '单玩家串行：等待上一个请求完成' : '发送给 AI 助手'
    this.input.disabled = this.pending
    this.renderCount()
    this.renderQuota()
    this.renderFeed()
  }

  focus(): void {
    this.input.focus({ preventScroll: true })
  }
}
