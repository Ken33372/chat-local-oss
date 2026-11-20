import { create } from 'zustand'
import type { MemorySettings } from './memory.js'

export type SetupStatus = {
  configured: boolean
  writable: boolean
  llm: {
    provider: string
    base_url: string
    model: string
    has_key: boolean
    header_names: string[]
    context_limit: number
    max_output_tokens: number
  }
  search: { provider: string; base_url: string; has_key: boolean; results: number }
  asr: { provider: string; base_url: string; has_key: boolean; model: string }
  ocr: { provider: string; base_url: string; has_key: boolean; model: string }
  rerank: { provider: string; base_url: string; has_key: boolean; model: string }
  embedding: {
    provider: string
    base_url: string
    has_key: boolean
    model: string
    dim: number
  }
  tts: {
    provider: string
    base_url: string
    has_key: boolean
    model: string
    voice: string
    response_format: string
  }
  capabilities: {
    llm: boolean
    search: boolean
    asr: boolean
    ocr: boolean
    tts: boolean
    memory: boolean
    embedding: boolean
  }
  memory: MemorySettings & {
    count: number
    pending: number
    limits: { text: number; items: number }
    embedding_error: string
  }
}

export type SetupBody = {
  llm: {
    provider: string
    base_url: string
    model: string
    api_key: string | null
    headers: string | null
    context_limit: number
    max_output_tokens: number
  }
  search: { provider: string; base_url: string; api_key: string | null; results: number }
  asr: { provider: string; base_url: string; api_key: string | null; model: string }
  ocr: { provider: string; base_url: string; api_key: string | null; model: string }
  rerank: { provider: string; base_url: string; api_key: string | null; model: string }
  embedding: {
    provider: string
    base_url: string
    api_key: string | null
    model: string
    dim: number
  }
  tts: {
    provider: string
    base_url: string
    api_key: string | null
    model: string
    voice: string
    response_format: string
  }
}

const headers = { 'X-Chat-Local': '1', 'Content-Type': 'application/json' }

export const loadSetupStatus = async (): Promise<SetupStatus> => {
  const response = await fetch('/api/setup/status')
  if (!response.ok) {
    throw new Error(`读取配置状态失败（${response.status}）`)
  }
  return (await response.json()) as SetupStatus
}

export const testSetup = async (
  body: SetupBody
): Promise<{ ok: boolean; status: number; models: string[]; detail: string }> => {
  const response = await fetch('/api/setup/test', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    detail?: string
    ok?: boolean
    status?: number
    models?: string[]
  }
  if (!response.ok) {
    throw new Error(payload.detail || `测试失败（${response.status}）`)
  }
  return {
    ok: Boolean(payload.ok),
    status: Number(payload.status || 0),
    models: payload.models || [],
    detail: payload.detail || '',
  }
}

export const saveSetup = async (body: SetupBody): Promise<SetupStatus> => {
  const response = await fetch('/api/setup/save', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as { detail?: string }
  if (!response.ok) {
    throw new Error(payload.detail || `保存失败（${response.status}）`)
  }
  return payload as unknown as SetupStatus
}

type WizardState = {
  open: boolean
  openWizard: () => void
  closeWizard: () => void
}

export const useSetupWizard = create<WizardState>((set) => ({
  open: false,
  openWizard: () => set({ open: true }),
  closeWizard: () => set({ open: false }),
}))
