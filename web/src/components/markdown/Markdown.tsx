import { memo, useMemo } from 'react'
import type { Source } from '../../services/chat/view.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { getStreamingBlockStarts } from '../../services/markdown/streaming.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const scrollToBottom = useScrollToBottom()
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const parsed = useMemo(() => {
    if (!throttledMarkdown) {
      return null
    }
    const ast = toMdAst(throttledMarkdown, { sources, disableLink })
    return {
      ast,
      streamingStarts: loading
        ? getStreamingBlockStarts(ast, throttledMarkdown)
        : { code: null, math: null },
    }
  }, [throttledMarkdown, sources, disableLink, loading])
  return parsed ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={parsed.ast}
      loading={loading}
      streamingCodeStart={parsed.streamingStarts.code}
      streamingMathStart={parsed.streamingStarts.math}
      onUpdate={scrollToBottom}
    />
  ) : null
})
