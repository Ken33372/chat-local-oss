import { useEffect, useRef, useState } from 'react'

/** 每次渲染后的最小间隔；新内容在这段时间内合并为最新文本 */
const MIN_INTERVAL = 120

/**
 * 流式过程中节流 Markdown 内容的更新：
 * 一次渲染提交后至少间隔 MIN_INTERVAL 才允许下一次更新；
 * 期间到达的新内容合并为最新文本一次提交。关闭节流时直接返回最新内容。
 */
export const useThrottleMarkdownRender = (content: string, enable: boolean) => {
  const updatableAtRef = useRef(0)
  const [output, setOutput] = useState(content)

  useEffect(() => {
    updatableAtRef.current = performance.now() + MIN_INTERVAL
  }, [output])

  useEffect(() => {
    if (!enable) {
      return
    }
    const update = () => {
      setOutput(content)
    }
    const delay = updatableAtRef.current - performance.now()
    if (delay <= 0) {
      update()
      return
    }
    const timer = setTimeout(update, delay)
    return () => clearTimeout(timer)
  }, [content, enable])

  return enable ? output : content
}
