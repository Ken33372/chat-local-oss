import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/**
 * 会话与附件存储改为本机后端（SQLite + data/files）。
 * 导出函数的签名与原 IndexedDB 实现保持一致，上层 store/history 逻辑不用改。
 */

export type StoredFile = {
  id: string
  blob: Blob
}

const HEADERS = { 'X-Chat-Local': '1' }

const fail = async (response: Response, action: string): Promise<never> => {
  const text = await response.text().catch(() => '')
  throw new Error(`${action}失败（${response.status}）${text ? `：${text.slice(0, 200)}` : ''}`)
}

const sendFile = async (base: string, file: StoredFile): Promise<void> => {
  const name = file.blob instanceof File ? file.blob.name : file.id
  const form = new FormData()
  form.append('file', file.blob, name)
  form.append('name', name)
  form.append('mime', file.blob.type)
  const response = await fetch(`${base}/${encodeURIComponent(file.id)}`, {
    method: 'POST',
    headers: HEADERS,
    body: form,
  })
  if (!response.ok) {
    await fail(response, '保存附件')
  }
}

const sendJson = async (url: string, method: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method,
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const response = await fetch('/api/chat/sessions')
  if (!response.ok) {
    await fail(response, '读取会话列表')
  }
  const body = (await response.json()) as { sessions: SessionSummary[] }
  return body.sessions.map(toSessionSummary)
}

export type SessionSearchMatch = {
  messageId: string
  role: 'user' | 'assistant' | 'title'
  snippet: string
  createdAt: number
}

export type SessionSearchResult = {
  id: string
  title: string
  updatedAt: number
  matchCount: number
  matches: SessionSearchMatch[]
}

export const searchSessions = async (
  query: string,
  signal?: AbortSignal
): Promise<SessionSearchResult[]> => {
  const response = await fetch(`/api/chat/search?q=${encodeURIComponent(query)}`, { signal })
  if (!response.ok) {
    await fail(response, '搜索会话')
  }
  const body = (await response.json()) as { results?: SessionSearchResult[] }
  return Array.isArray(body.results) ? body.results : []
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    await fail(response, '读取会话')
  }
  return (await response.json()) as Session
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  for (const file of files) {
    await sendFile('/api/chat/files', file)
  }
  const response = await sendJson(
    `/api/chat/sessions/${encodeURIComponent(session.id)}`,
    'PUT',
    session
  )
  if (!response.ok) {
    await fail(response, '保存会话')
  }
}

/** 未打开的会话也可重命名 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const response = await sendJson(
    `/api/chat/sessions/${encodeURIComponent(id)}/title`,
    'PATCH',
    { title }
  )
  if (!response.ok) {
    await fail(response, '重命名会话')
  }
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: HEADERS,
  })
  if (!response.ok) {
    await fail(response, '删除会话')
  }
}

export const archiveSession = async (sessionId: string, archived: boolean): Promise<void> => {
  const response = await sendJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/archive`,
    'PATCH',
    { archived }
  )
  if (!response.ok) {
    await fail(response, archived ? '归档会话' : '恢复会话')
  }
}

export type MaintenancePreview = {
  delete: { sessions: number; files: number; bytes: number }
  clean: { sessions: number; toolBlocks: number; images: number; bytes: number }
}

export type MaintenanceResult = {
  sessions: number
  files?: number
  toolBlocks?: number
  images?: number
  bytes: number
}

const maintenance = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await sendJson(`/api/chat/maintenance/${path}`, 'POST', body)
  if (!response.ok) {
    await fail(response, '清理对话')
  }
  return (await response.json()) as T
}

export const previewMaintenance = (
  body: Record<string, unknown>
): Promise<MaintenancePreview> => maintenance('preview', body)

export const deleteSessionsByTime = (
  body: Record<string, unknown>
): Promise<MaintenanceResult> => maintenance('delete', body)

export const cleanSessionContent = (
  body: { toolRecords: boolean; images: boolean }
): Promise<MaintenanceResult> => maintenance('clean', body)

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await sendFile('/api/chat/files', file)
  }
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await fetch(`/api/chat/files/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    await fail(response, '读取附件')
  }
  return response.blob()
}

/** 历史导入暂存：全部写入后端暂存区，校验通过后一次性替换正式数据。 */
export const clearStaging = async (): Promise<void> => {
  const response = await fetch('/api/chat/staging/clear', { method: 'POST', headers: HEADERS })
  if (!response.ok) {
    await fail(response, '清理导入暂存')
  }
}

export const addStagingSession = async (session: Session): Promise<void> => {
  const response = await sendJson('/api/chat/staging/sessions', 'POST', session)
  if (!response.ok) {
    await fail(response, '写入导入暂存')
  }
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await sendFile('/api/chat/staging/files', file)
  }
}

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const response = await sendJson('/api/chat/staging/file-types', 'POST', {
    types: Object.fromEntries(types),
  })
  if (!response.ok) {
    await fail(response, '修正导入附件类型')
  }
}

export type ImportMode = 'replace' | 'merge-skip' | 'merge-copy'

export const commitStaging = async (
  mode: ImportMode = 'replace'
): Promise<{ sessions: SessionSummary[]; added: number }> => {
  const response = await sendJson('/api/chat/staging/commit', 'POST', { mode })
  if (!response.ok) {
    await fail(response, '提交导入数据')
  }
  const body = (await response.json()) as { sessions: SessionSummary[]; added?: number }
  return {
    sessions: body.sessions.map(toSessionSummary),
    added: body.added ?? 0,
  }
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
