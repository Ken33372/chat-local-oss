const guard = { 'X-Chat-Local': '1', 'Content-Type': 'application/json' }

export type DebugLogLine = {
  seq: number
  ts: string
  level: string
  name: string
  text: string
}

export type DebugStatus = {
  app: {
    uptime: number
    data_dir: string
    context_limit: number
    output_limit: number
    capabilities: Record<string, boolean>
  }
  llm: { configured: boolean; provider: string; base: string; model: string }
  embedding: {
    configured: boolean
    provider: string
    base: string
    model: string
    dim: number
    has_key: boolean
  }
  rerank: {
    configured: boolean
    provider: string
    base_url: string
    model: string
    has_key: boolean
    ok: boolean
    detail: string
    probed: boolean
  }
  search: {
    provider: string
    available: boolean
    base: string
    searxng: boolean
    engines: { engines: number; probed: boolean; ok: boolean | null }
  }
  memory: {
    enabled: boolean
    items: number
    pinned: number
    vectors: number
    vectors_missing: number
    vector_model: string
    vector_dim: number
    pending: number
    inject_mode: string
    inject_count: number
    search_mode: string
    sim_threshold: number
    tools: boolean
    write: string
    embedding_configured: boolean
    rerank_configured: boolean
    last_error: string
  }
  prompts: { cards: number; active: string; chars: number }
  asr: { ok?: boolean; provider?: string } & Record<string, unknown>
  ocr: { ok?: boolean; image?: string; document?: string } & Record<string, unknown>
  tts: { ok?: boolean; provider?: string; voice?: string } & Record<string, unknown>
}

export type DebugProbeResult = {
  target: string
  ok: boolean
  /** warn = 连不上或服务自报未就绪；error = 明确报错 */
  state?: 'ok' | 'warn' | 'error'
  ms: number
  detail: string
  extra?: Record<string, unknown>
}

const json = async <T,>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export const loadDebugStatus = async (): Promise<DebugStatus> => {
  const response = await fetch('/api/debug/status', { headers: guard })
  return json<DebugStatus>(response)
}

export const loadDebugLogs = async (after: number, limit = 300) => {
  const response = await fetch(`/api/debug/logs?after=${after}&limit=${limit}`, { headers: guard })
  return json<{ lines: DebugLogLine[]; last: number }>(response)
}

export const runDebugProbe = async (target: string): Promise<DebugProbeResult> => {
  const response = await fetch('/api/debug/probe', {
    method: 'POST',
    headers: guard,
    body: JSON.stringify({ target }),
  })
  return json<DebugProbeResult>(response)
}

export const PROBE_TARGETS = ['llm', 'embedding', 'rerank', 'search', 'memory', 'asr', 'tts'] as const
