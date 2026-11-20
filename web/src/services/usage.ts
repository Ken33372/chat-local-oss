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

const json = async <T,>(response: Response): Promise<T> => {
  const payload = (await response.json().catch(() => ({}))) as { detail?: string }
  if (!response.ok) {
    throw new Error(payload.detail || `请求失败（${response.status}）`)
  }
  return payload as T
}

/** 上报失败不打扰对话：统计不是主链路，页面关闭时 keepalive 尽量把请求送出 */
export const recordUsage = async (event: UsageEvent): Promise<void> => {
  try {
    await fetch('/api/usage/record', {
      method: 'POST',
      headers: guard,
      body: JSON.stringify(event),
      keepalive: true,
    })
  } catch {
    // 忽略：服务未启动或页面正在关闭
  }
}

export const loadUsageSummary = async (days: number): Promise<UsageSummary> => {
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
  const response = await fetch('/api/usage/clear', { method: 'POST', headers: guard })
  await json<{ ok: boolean }>(response)
}
