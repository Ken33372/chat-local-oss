/** 用量统计：每轮对话结束上报一次，统计页读取按天/按模型聚合结果。 */

const guard = { 'X-Chat-Local': '1', 'Content-Type': 'application/json' }

export type UsageEvent = {
  id: string
  sessionId: string
  model: string
  mode: 'cloud' | 'local'
  usage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    output_tokens: number
  }
}

export type UsagePricing = {
  input: number
  cache_read: number
  output: number
  currency: 'CNY' | 'USD'
}

/** 输入含未命中缓存与写入缓存两部分；cache_read 单列，便于算命中率 */
export type UsageBucket = {
  calls: number
  input: number
  cache_read: number
  cache_creation: number
  output: number
  hit_rate: number
  cost: number
}

export type UsageSummary = {
  days: number
  pricing: UsagePricing
  totals: UsageBucket
  daily: (UsageBucket & { date: string })[]
  models: (UsageBucket & { model: string; mode: string })[]
}

const json = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json().catch(() => ({}))) as { detail?: string }
  if (!response.ok) {
    throw new Error(payload.detail || `请求失败（${response.status}）`)
  }
  return payload as T
}

/** 只缓存统计白名单，不缓存请求密钥、提示词或对话正文。ID 在补传时保持不变。 */
const QUEUE_KEY = 'chat-local.pending-usage.v1'
const pending = new Map<string, UsageEvent>()
const cleanEvent = (value: UsageEvent): UsageEvent => ({
  id: value.id,
  sessionId: value.sessionId,
  model: value.model,
  mode: value.mode,
  usage: {
    input_tokens: value.usage.input_tokens,
    cache_creation_input_tokens: value.usage.cache_creation_input_tokens,
    cache_read_input_tokens: value.usage.cache_read_input_tokens,
    output_tokens: value.usage.output_tokens,
  },
})
try {
  const stored: UsageEvent[] = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')
  for (const value of stored) {
    if (
      value &&
      typeof value.id === 'string' &&
      typeof value.sessionId === 'string' &&
      typeof value.model === 'string' &&
      value.mode === 'cloud' &&
      value.usage &&
      [
        value.usage.input_tokens,
        value.usage.cache_creation_input_tokens,
        value.usage.cache_read_input_tokens,
        value.usage.output_tokens,
      ].every((count) => Number.isFinite(count) && count >= 0)
    ) {
      pending.set(value.id, cleanEvent(value))
    }
  }
} catch {
  // 无本地存储权限时仍保留内存补传队列。
}
const savePending = () => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([...pending.values()]))
  } catch {
    // 配额/隐私模式故障不能中断聊天。
  }
}
let sending: Promise<void> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let clearing = false

export const retryPendingUsage = (): Promise<void> => {
  if (sending) {
    return sending
  }
  if (clearing) {
    return Promise.resolve()
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
  }
  retryTimer = undefined
  sending = Promise.resolve()
    .then(async () => {
      for (const event of pending.values()) {
        try {
          const response = await fetch('/api/usage/record', {
            method: 'POST',
            headers: guard,
            body: JSON.stringify({
              id: event.id,
              session_id: event.sessionId,
              model: event.model,
              mode: event.mode,
              usage: event.usage,
            }),
            keepalive: true,
            signal: AbortSignal.timeout(10000),
          })
          if (!response.ok) {
            throw new Error(`Usage HTTP ${response.status}`)
          }
          pending.delete(event.id)
          savePending()
        } catch {
          break
        }
      }
    })
    .finally(() => {
      sending = undefined
      if (pending.size > 0 && !clearing) {
        retryTimer = setTimeout(() => {
          void retryPendingUsage()
        }, 30000)
      }
    })
  return sending
}

/** 本地请求已由后端记账；云请求失败时留队，不打断聊天。 */
export const recordUsage = (event: UsageEvent): Promise<void> => {
  if (event.mode !== 'cloud') {
    return Promise.resolve()
  }
  pending.set(event.id, cleanEvent(event))
  savePending()
  return retryPendingUsage()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void retryPendingUsage()
  })
  if (pending.size > 0) {
    void retryPendingUsage()
  }
}

export const loadUsageSummary = async (days: number): Promise<UsageSummary> => {
  await retryPendingUsage()
  const response = await fetch(`/api/usage/summary?days=${days}`)
  return json<UsageSummary>(response)
}

export const saveUsagePricing = async (pricing: UsagePricing): Promise<UsagePricing> => {
  const response = await fetch('/api/usage/pricing', {
    method: 'PATCH',
    headers: guard,
    body: JSON.stringify(pricing),
  })
  return json<UsagePricing>(response)
}

export const clearUsage = async (): Promise<void> => {
  clearing = true
  if (retryTimer) {
    clearTimeout(retryTimer)
  }
  const ids = [...pending.keys()]
  try {
    await sending
    const response = await fetch('/api/usage/clear', { method: 'POST', headers: guard })
    await json<{ ok: boolean }>(response)
    ids.forEach((id) => pending.delete(id))
    savePending()
  } finally {
    clearing = false
    void retryPendingUsage()
  }
}
