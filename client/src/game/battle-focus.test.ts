// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { hasBattleFocus } from './battle-focus'

afterEach(() => { document.body.replaceChildren() })

describe('battle interaction focus domain', () => {
  it('keeps both thumbs enabled when a battle-action button has focus', () => {
    document.body.innerHTML = '<main id="stage"><canvas></canvas><div data-battle-control><button><span>护盾</span></button></div></main>'
    const canvas = document.querySelector('canvas')!
    expect(hasBattleFocus(canvas, canvas)).toBe(true)
    expect(hasBattleFocus(document.querySelector('button'), canvas)).toBe(true)
    expect(hasBattleFocus(document.querySelector('span'), canvas)).toBe(true)
  })

  it('excludes editors, text entry and unrelated buttons', () => {
    document.body.innerHTML = '<main><canvas></canvas><div data-battle-control><input><div contenteditable><button>edit</button></div></div><button id="menu">menu</button></main>'
    const canvas = document.querySelector('canvas')!
    expect(hasBattleFocus(document.querySelector('input'), canvas)).toBe(false)
    expect(hasBattleFocus(document.querySelector('[contenteditable] button'), canvas)).toBe(false)
    expect(hasBattleFocus(document.querySelector('#menu'), canvas)).toBe(false)
    expect(hasBattleFocus(null, canvas)).toBe(false)
  })

  it('does not accept controls outside this battle stage', () => {
    document.body.innerHTML = '<main><canvas></canvas></main><div data-battle-control><button>other battle</button></div>'
    expect(hasBattleFocus(document.querySelector('button'), document.querySelector('canvas')!)).toBe(false)
  })
})
