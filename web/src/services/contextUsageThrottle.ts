import type { Session } from './chat/types.js'

export type ContextUsageInput = {
  session: Session | undefined
  draft: string
  streaming: boolean
  applySummary: boolean
}

export type ContextUsageSnapshot = ContextUsageInput & { used: number }

type Timer = ReturnType<typeof setTimeout>
type Options = {
  interval?: number
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => Timer
  clearTimer?: (timer: Timer) => void
  onChange?: (snapshot: ContextUsageSnapshot) => void
}

const sameInput = (a: ContextUsageInput, b: ContextUsageInput) =>
  a.session === b.session &&
  a.draft === b.draft &&
  a.streaming === b.streaming &&
  a.applySummary === b.applySummary

/**
 * 流式会话最多按 interval 重新估算；草稿、切会话和停止时立即提交最新值。
 * 定时器只保存一个，并读取最后输入，避免闭包停留在旧会话或旧草稿。
 */
export const createContextUsageThrottle = (
  estimate: (input: ContextUsageInput) => number,
  {
    interval = 250,
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    onChange = () => undefined,
  }: Options = {}
) => {
  const minInterval = Math.max(0, interval)
  let latest: ContextUsageInput | undefined
  let current: ContextUsageSnapshot | undefined
  let timer: Timer | undefined
  let updatedAt = 0

  const cancel = () => {
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
  }
  const commit = (input: ContextUsageInput) => {
    const next = { ...input, used: estimate(input) }
    current = next
    updatedAt = now()
    onChange(next)
    return next
  }
  const update = (input: ContextUsageInput): ContextUsageSnapshot => {
    latest = input
    if (current && sameInput(current, input)) {
      return current
    }
    if (
      !current ||
      current.session?.id !== input.session?.id ||
      current.draft !== input.draft ||
      current.streaming !== input.streaming ||
      current.applySummary !== input.applySummary ||
      !input.streaming
    ) {
      cancel()
      return commit(input)
    }
    const delay = minInterval - (now() - updatedAt)
    if (delay <= 0) {
      cancel()
      return commit(input)
    }
    if (timer === undefined) {
      timer = setTimer(() => {
        timer = undefined
        if (latest) {
          commit(latest)
        }
      }, delay)
    }
    return current
  }

  return {
    update,
    flush: () => {
      cancel()
      return latest ? commit(latest) : current
    },
    cancel,
  }
}
