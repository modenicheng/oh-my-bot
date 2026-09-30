import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import {
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from 'monaco-editor/languages/features/typescript/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'
import botApiSource from '../../../packages/bot-api/src/index.ts?raw'

export interface BotEditor {
  getValue(): string
  setValue(source: string): void
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

javascriptDefaults.setCompilerOptions({
  allowJs: true,
  checkJs: true,
  allowNonTsExtensions: true,
  target: ScriptTarget.ES2020,
  module: ModuleKind.CommonJS,
  moduleResolution: ModuleResolutionKind.NodeJs,
  // Goja has ECMAScript built-ins, but no browser globals such as window or fetch.
  lib: ['lib.es2020.d.ts'],
  noEmit: true,
})
javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
})

monaco.editor.defineTheme('omb-bot', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#10141a',
    'editor.foreground': '#d8dee9',
    'editor.lineHighlightBackground': '#161b24',
    'editor.lineHighlightBorder': '#1f2733',
    'editorLineNumber.foreground': '#8b98a9',
    'editorLineNumber.activeForeground': '#d8dee9',
    'editorCursor.foreground': '#22d3ee',
    'editor.selectionBackground': '#22d3ee33',
    'editor.inactiveSelectionBackground': '#1f2733',
    'editorIndentGuide.background1': '#1f2733',
    'editorIndentGuide.activeBackground1': '#8b98a9',
    'editorWidget.background': '#10141a',
    'editorWidget.border': '#1f2733',
    'editorSuggestWidget.background': '#10141a',
    'editorSuggestWidget.border': '#1f2733',
    'editorSuggestWidget.foreground': '#d8dee9',
    'editorSuggestWidget.highlightForeground': '#22d3ee',
    'editorSuggestWidget.selectedBackground': '#1f2733',
    'focusBorder': '#22d3ee',
  },
})

export function createBotEditor(
  container: HTMLElement,
  source: string,
  callbacks: {
    onChange: (source: string) => void
    onSubmit: () => void
    onDiagnostics: (errors: number, warnings: number) => void
  },
): BotEditor {
  const apiTypes = javascriptDefaults.addExtraLib(
    `declare module '@omb/bot-api' {\n${botApiSource}\n}`,
    'file:///bot-api.d.ts',
  )
  const model = monaco.editor.createModel(source, 'javascript', monaco.Uri.parse('file:///bot.js'))
  const editor = monaco.editor.create(container, {
    model,
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
    const markers = monaco.editor.getModelMarkers({ resource: model.uri })
    let errors = 0
    let warnings = 0
    for (const marker of markers) {
      if (marker.severity === monaco.MarkerSeverity.Error) errors++
      else if (marker.severity === monaco.MarkerSeverity.Warning) warnings++
    }
    callbacks.onDiagnostics(errors, warnings)
  }
  const subscriptions = [
    model.onDidChangeContent(() => callbacks.onChange(model.getValue())),
    monaco.editor.onDidChangeMarkers(resources => {
      if (resources.some(resource => resource.toString() === model.uri.toString())) reportDiagnostics()
    }),
    editor.addAction({
      id: 'omb.bot.submit',
      label: '提交机器人脚本',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => callbacks.onSubmit(),
    }),
  ]
  reportDiagnostics()
  let disposed = false
  return {
    getValue: () => model.getValue(),
    setValue(value) {
      if (value !== model.getValue()) model.setValue(value)
    },
    focus: () => editor.focus(),
    dispose() {
      if (disposed) return
      disposed = true
      for (const subscription of subscriptions) subscription.dispose()
      editor.dispose()
      model.dispose()
      apiTypes.dispose()
    },
  }
}
