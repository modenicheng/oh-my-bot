import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import {
  getTypeScriptWorker,
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults,
} from 'monaco-editor/languages/features/typescript/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'
import botApiSource from '../../../packages/bot-api/src/index.ts?raw'
import { completionContext, seedsForContext, type CompletionSeed } from './bot-completions'
import type { BotLanguage } from './ts-submit'
import { cleanEmittedJs, formatTsErrors, pickEmitJs } from './ts-submit'

export interface TsCompileFailure {
  ok: false
  errors: string[]
}

export interface TsCompileSuccess {
  ok: true
  js: string
}

export type TsCompileResult = TsCompileFailure | TsCompileSuccess

export interface BotEditor {
  getValue(): string
  setValue(source: string): void
  getLanguage(): BotLanguage
  setLanguage(language: BotLanguage): void
  compile(): Promise<TsCompileResult>
  focus(): void
  dispose(): void
}

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return label === 'javascript' || label === 'typescript'
      ? new TypeScriptWorker()
      : new EditorWorker()
  },
}

// 提交产物要交给 Goja 跑：module 必须保持 ESNext（CommonJS 会发射
// exports.x = ... 运行时代码，服务器无法加载），由服务器剥掉命名声明
// 前的 export 关键字；noEmit 关闭，getEmitOutput 才会产出 JS。
const EMIT_COMPILER_OPTIONS = {
  allowNonTsExtensions: true,
  target: ScriptTarget.ES2020,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.NodeJs,
  // Goja has ECMAScript built-ins, but no browser globals such as window or fetch.
  lib: ['lib.es2020.d.ts'],
}

javascriptDefaults.setCompilerOptions({
  allowJs: true,
  checkJs: true,
  ...EMIT_COMPILER_OPTIONS,
  noEmit: true,
})
typescriptDefaults.setCompilerOptions({ ...EMIT_COMPILER_OPTIONS })
// 提交前通过 worker 编译，模型内容必须即时同步到 worker。
typescriptDefaults.setEagerModelSync(true)
for (const defaults of [javascriptDefaults, typescriptDefaults]) {
  defaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  })
}

// 深底衬高对比代码：背景用页面底色 bg-0，正文 text 白；荧光只给
// 光标/选中/括号匹配等状态，同屏不超过两主色（STYLE.md 荧光纪律）。
monaco.editor.defineTheme('omb-bot', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0a0e14',
    'editor.foreground': '#d8dee9',
    'editor.lineHighlightBackground': '#11161f',
    'editor.lineHighlightBorder': '#1f2733',
    'editorLineNumber.foreground': '#4a5666',
    'editorLineNumber.activeForeground': '#d8dee9',
    'editorCursor.foreground': '#22d3ee',
    'editor.selectionBackground': '#22d3ee2e',
    'editor.inactiveSelectionBackground': '#1f2733',
    'editorIndentGuide.background1': '#1f2733',
    'editorIndentGuide.activeBackground1': '#4a5666',
    'editorWidget.background': '#10141a',
    'editorWidget.border': '#2a3542',
    'editorSuggestWidget.background': '#10141a',
    'editorSuggestWidget.border': '#2a3542',
    'editorSuggestWidget.foreground': '#d8dee9',
    'editorSuggestWidget.highlightForeground': '#22d3ee',
    'editorSuggestWidget.selectedBackground': '#1f2733',
    'editorHoverWidget.background': '#10141a',
    'editorHoverWidget.border': '#2a3542',
    'editorBracketMatch.background': '#22d3ee1f',
    'editorBracketMatch.border': '#22d3ee66',
    'focusBorder': '#22d3ee',
  },
})

const TS_MODEL_URI = 'file:///bot.ts'
const JS_MODEL_URI = 'file:///bot.js'
const TS_MODEL_MONACO_URI = monaco.Uri.parse(TS_MODEL_URI)

function toCompletionItem(seed: CompletionSeed): Omit<monaco.languages.CompletionItem, 'range'> {
  return {
    label: seed.label,
    kind:
      seed.kind === 'method' ? monaco.languages.CompletionItemKind.Method
      : seed.kind === 'property' ? monaco.languages.CompletionItemKind.Property
      : seed.kind === 'snippet' ? monaco.languages.CompletionItemKind.Snippet
      : monaco.languages.CompletionItemKind.Keyword,
    insertText: seed.insert,
    insertTextRules:
      seed.insert.includes('$') ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    detail: seed.detail,
    sortText: seed.kind === 'keyword' || seed.kind === 'snippet' ? `0${seed.label}` : undefined,
  }
}

export function createBotEditor(
  container: HTMLElement,
  source: string,
  callbacks: {
    onChange: (source: string) => void
    onSubmit: () => void
    onDiagnostics: (errors: number, warnings: number) => void
    onLanguageChange?: (language: BotLanguage) => void
  },
  initialLanguage: BotLanguage = 'js',
): BotEditor {
  // 两个语言各建一个模型，Bot API 声明同时挂到两套 defaults 上。
  const consoleTypes = `declare const console: import('@omb/bot-api').ScriptConsole`
  const apiTypes = [
    javascriptDefaults.addExtraLib(
      `declare module '@omb/bot-api' {\n${botApiSource}\n}\n${consoleTypes}`,
      'file:///bot-api.d.ts',
    ),
    typescriptDefaults.addExtraLib(
      `declare module '@omb/bot-api' {\n${botApiSource}\n}\n${consoleTypes}`,
      'file:///bot-api-ts.d.ts',
    ),
  ]
  const models = {
    js: monaco.editor.createModel(source, 'javascript', monaco.Uri.parse(JS_MODEL_URI)),
    ts: monaco.editor.createModel(source, 'typescript', monaco.Uri.parse(TS_MODEL_URI)),
  }
  let language: BotLanguage = initialLanguage
  const editor = monaco.editor.create(container, {
    model: models[language],
    theme: 'omb-bot',
    fontFamily: 'Consolas, monospace',
    fontSize: 13,
    lineNumbers: 'on',
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    ariaLabel: '机器人脚本编辑器',
    tabSize: 2,
    insertSpaces: true,
  })
  const reportDiagnostics = () => {
    const markers = monaco.editor.getModelMarkers({ resource: models[language].uri })
    let errors = 0
    let warnings = 0
    for (const marker of markers) {
      if (marker.severity === monaco.MarkerSeverity.Error) errors++
      else if (marker.severity === monaco.MarkerSeverity.Warning) warnings++
    }
    callbacks.onDiagnostics(errors, warnings)
  }
  const subscriptions = [
    models.js.onDidChangeContent(() => { if (language === 'js') callbacks.onChange(models.js.getValue()) }),
    models.ts.onDidChangeContent(() => { if (language === 'ts') callbacks.onChange(models.ts.getValue()) }),
    monaco.editor.onDidChangeMarkers(resources => {
      if (resources.some(resource => resource.toString() === models[language].uri.toString())) reportDiagnostics()
    }),
    editor.addAction({
      id: 'omb.bot.submit',
      label: '提交机器人脚本',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => callbacks.onSubmit(),
    }),
    // Bot API 前缀补全：bot / bot.scan() / metadata 成员链。TS worker 已覆盖能推断的
    // 通用补全，这里只补 JSDoc 类型链失效时仍可用的入口与方法，随编辑器销毁。
    // 两种语言注册同一 provideCompletionItems：实现只依赖 model/position，与语言无关。
    ...(['javascript', 'typescript'] as const).map(lang =>
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.'],
        provideCompletionItems(model, position) {
          const linePrefix = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          })
          const context = completionContext(linePrefix)
          const seeds = seedsForContext(context)
          if (seeds.length === 0) return { suggestions: [] }
          const word = model.getWordUntilPosition(position)
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: context.atDot ? position.column : word.startColumn,
            endColumn: position.column,
          }
          return { suggestions: seeds.map(seed => ({ ...toCompletionItem(seed), range })) }
        },
      })),
  ]
  reportDiagnostics()
  let disposed = false
  return {
    getValue: () => models[language].getValue(),
    setValue(value) {
      if (value !== models[language].getValue()) models[language].setValue(value)
    },
    getLanguage: () => language,
    setLanguage(next) {
      if (next === language) return
      const outgoing = models[language]
      const incoming = models[next]
      const source = outgoing.getValue()
      incoming.setValue(source)
      language = next
      editor.setModel(incoming)
      callbacks.onLanguageChange?.(next)
      reportDiagnostics()
    },
    async compile() {
      const source = models.ts.getValue()
      const getWorker = await getTypeScriptWorker()
      const client = await getWorker(TS_MODEL_MONACO_URI)
      const [syntactic, semantic] = await Promise.all([
        client.getSyntacticDiagnostics(TS_MODEL_URI),
        client.getSemanticDiagnostics(TS_MODEL_URI),
      ])
      const errors = formatTsErrors(source, [...syntactic, ...semantic])
      if (errors.length > 0) return { ok: false as const, errors }
      const output = await client.getEmitOutput(TS_MODEL_URI)
      if (output.emitSkipped) {
        return { ok: false as const, errors: ['TypeScript 编译被跳过：无法生成 JavaScript。'] }
      }
      const js = pickEmitJs(output.outputFiles)
      if (js === undefined) return { ok: false as const, errors: ['TypeScript 编译未产出 JavaScript。'] }
      return { ok: true as const, js: cleanEmittedJs(js) }
    },
    focus: () => editor.focus(),
    dispose() {
      if (disposed) return
      disposed = true
      for (const subscription of subscriptions) subscription.dispose()
      editor.dispose()
      models.js.dispose()
      models.ts.dispose()
      for (const lib of apiTypes) lib.dispose()
    },
  }
}
