import { describe, expect, it } from 'vitest'
import { decodeToken, extractTokenFromSearch } from './auth'

// b64url(JSON) 手工构造 token（签名段不参与客户端解码，任意非空即可）。
function fakeToken(payload: Record<string, unknown>): string {
  const head = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${head}.sig`
}

describe('decodeToken', () => {
  it('decodes payload claims', () => {
    const claims = decodeToken(fakeToken({ sub: 'sub-1', name: 'alice', exp: 1234 }))
    expect(claims).toEqual({ sub: 'sub-1', name: 'alice', exp: 1234 })
  })

  it('handles unicode names', () => {
    expect(decodeToken(fakeToken({ sub: 's', name: '小凯', exp: 1 }))?.name).toBe('小凯')
  })

  it('rejects malformed tokens', () => {
    expect(decodeToken('')).toBeNull()
    expect(decodeToken('not-a-token')).toBeNull() // 非法 base64
    expect(decodeToken(`${btoa('[]')}.sig`)).toBeNull() // 载荷非对象
    expect(decodeToken(fakeToken({ name: 'alice', exp: 1 }))).toBeNull() // 缺 sub
    expect(decodeToken(fakeToken({ sub: 's', name: 'alice' }))).toBeNull() // 缺 exp
  })
})

describe('extractTokenFromSearch', () => {
  it('extracts token and ignores tokenless URLs', () => {
    expect(extractTokenFromSearch('?token=a.b&room=HEAL')).toBe('a.b')
    expect(extractTokenFromSearch('?room=HEAL')).toBeNull()
    expect(extractTokenFromSearch('?token=plain')).toBeNull() // 无签名段：非登录回跳
  })
})
