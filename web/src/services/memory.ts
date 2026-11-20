import { create } from 'zustand'

export type MemoryItem = {
  id: number
  text: string
  pinned: boolean
  source: string
  createdAt: number
  updatedAt: number
}

export type MemoryProposal = {
  id: number
  kind: string
  text: string
  pinned: boolean
  createdAt: number
}

export type MemorySettings = {
  enabled: boolean
  /** 旧字段，保留兼容；实际选择看 inject_mode */
  inject: 'recent' | 'off'
  inject_mode: 'off' | 'recent' | 'keyword' | 'embedding'
  search_mode: 'keyword' | 'score' | 'embedding'
  inject_count: number
  tools: boolean
  write: 'propose' | 'off'
}

const guard = { 'X-Chat-Local': '1', 'Content-Type': 'application/json' }

const json = async <T,>(response: Response): Promise<T> => {
  const payload = (await response.json().catch(() => ({}))) as { detail?: string }
  if (!response.ok) {
    throw new Error(payload.detail || `请求失败（${response.status}）`)
  }
  return payload as T
}

export const loadMemoryItems = async (): Promise<MemoryItem[]> => {
  const response = await fetch('/api/memory/items')
  const payload = await json<{ items: MemoryItem[] }>(response)
  return payload.items
}

export const addMemory = async (text: string, pinned: boolean): Promise<MemoryItem> => {
  const response = await fetch('/api/memory/items', {
    method: 'POST',
    headers: guard,
    body: JSON.stringify({ text, pinned }),
  })
  return json<MemoryItem>(response)
}

export const updateMemory = async (
  id: number,
  text: string,
  pinned: boolean
): Promise<MemoryItem> => {
  const response = await fetch(`/api/memory/items/${id}`, {
    method: 'PATCH',
    headers: guard,
    body: JSON.stringify({ text, pinned }),
  })
  return json<MemoryItem>(response)
}

export const deleteMemory = async (id: number): Promise<void> => {
  const response = await fetch(`/api/memory/items/${id}`, {
    method: 'DELETE',
    headers: guard,
  })
  await json<{ ok: boolean }>(response)
}

export const loadProposals = async (): Promise<MemoryProposal[]> => {
  const response = await fetch('/api/memory/proposals')
  const payload = await json<{ proposals: MemoryProposal[] }>(response)
  return payload.proposals
}

export const acceptProposal = async (id: number): Promise<void> => {
  const response = await fetch(`/api/memory/proposals/${id}/accept`, {
    method: 'POST',
    headers: guard,
  })
  await json<{ ok: boolean }>(response)
}

export const rejectProposal = async (id: number): Promise<void> => {
  const response = await fetch(`/api/memory/proposals/${id}/reject`, {
    method: 'POST',
    headers: guard,
  })
  await json<{ ok: boolean }>(response)
}

export const saveMemorySettings = async (settings: MemorySettings): Promise<void> => {
  const response = await fetch('/api/memory/settings', {
    method: 'PATCH',
    headers: guard,
    body: JSON.stringify(settings),
  })
  await json<MemorySettings>(response)
}

export const clearMemories = async (): Promise<void> => {
  const response = await fetch('/api/memory/clear', { method: 'POST', headers: guard })
  await json<{ ok: boolean }>(response)
}

export const exportMemories = async (): Promise<string> => {
  const response = await fetch('/api/memory/export')
  const payload = await json<{ text: string }>(response)
  return payload.text
}

export const importMemories = async (
  text: string
): Promise<{ added: number; skipped: number; total: number }> => {
  const response = await fetch('/api/memory/import', {
    method: 'POST',
    headers: guard,
    body: JSON.stringify({ text }),
  })
  return json<{ added: number; skipped: number; total: number }>(response)
}

/** 输入框上方的待确认提示：只存数量，内容在设置里看 */
export const useMemoryStore = create<{ pending: number; refresh: () => Promise<void> }>((set) => ({
  pending: 0,
  refresh: async () => {
    try {
      const proposals = await loadProposals()
      set({ pending: proposals.length })
    } catch {
      // 后端没开记忆或请求失败时保持原值，不打扰聊天
    }
  },
}))
