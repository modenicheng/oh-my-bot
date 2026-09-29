// 回放 API 客户端：GET /api/matches（对局列表）与 GET /api/replay/<id>（NDJSON 流）。
// 同源 fetch（embed 前端与 API 同端口），错误统一抛 ReplayApiError。

export class ReplayApiError extends Error {}

/** 对局条目（列表页展示用）。 */
export interface MatchEntry {
  id: string
  /** 房间码（id 前缀，- 前的部分）。 */
  roomCode: string
  /** 对局序号（id 后缀）。 */
  seq: number
}

/** 拉取对局列表（服务器按文件名排序）。 */
export async function fetchMatches(): Promise<MatchEntry[]> {
  let resp: Response
  try {
    resp = await fetch('/api/matches')
  } catch (e) {
    throw new ReplayApiError(`网络错误: ${(e as Error).message}`)
  }
  if (!resp.ok) {
    throw new ReplayApiError(`对局列表请求失败 HTTP ${resp.status}`)
  }
  let data: unknown
  try {
    data = await resp.json()
  } catch (e) {
    throw new ReplayApiError(`对局列表解析失败: ${(e as Error).message}`)
  }
  if (!Array.isArray(data)) throw new ReplayApiError('对局列表格式异常')
  return data
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((id) => {
      const i = id.lastIndexOf('-')
      const roomCode = i > 0 ? id.slice(0, i) : id
      const seqRaw = i > 0 ? id.slice(i + 1) : ''
      const seq = /^\d+$/.test(seqRaw) ? parseInt(seqRaw, 10) : 0
      return { id, roomCode, seq }
    })
}

/** 下载并返回单局完整 NDJSON 文本。 */
export async function fetchReplayText(id: string): Promise<string> {
  let resp: Response
  try {
    resp = await fetch(`/api/replay/${encodeURIComponent(id)}`)
  } catch (e) {
    throw new ReplayApiError(`网络错误: ${(e as Error).message}`)
  }
  if (!resp.ok) {
    throw new ReplayApiError(`回放下载失败 HTTP ${resp.status}`)
  }
  try {
    return await resp.text()
  } catch (e) {
    throw new ReplayApiError(`回放读取失败: ${(e as Error).message}`)
  }
}
