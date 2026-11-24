import { useEffect, useRef, useState } from 'react'
import { getContextUsage } from '../../services/context.js'
import {
  createContextUsageThrottle,
  type ContextUsageInput,
  type ContextUsageSnapshot,
} from '../../services/contextUsageThrottle.js'

/** 只节流昂贵的逐字估算；ContextBar 的按钮、摘要和阈值仍使用当前会话状态。 */
export const useContextUsage = (input: ContextUsageInput): number => {
  const { session, draft, streaming, applySummary } = input
  const notifyRef = useRef<(snapshot: ContextUsageSnapshot) => void>(() => undefined)
  const controllerRef = useRef<ReturnType<typeof createContextUsageThrottle> | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createContextUsageThrottle(
      (snapshot) => getContextUsage(snapshot.session, snapshot.draft, snapshot.applySummary),
      { onChange: (snapshot) => notifyRef.current(snapshot) }
    )
  }
  const controller = controllerRef.current
  const [snapshot, setSnapshot] = useState(() => controller.update(input))
  notifyRef.current = setSnapshot

  useEffect(() => () => controller.cancel(), [controller])
  useEffect(() => {
    controller.update({ session, draft, streaming, applySummary })
  }, [controller, session, draft, streaming, applySummary])

  return snapshot.used
}
