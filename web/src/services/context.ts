import { dropCompressed, getVisibleMessages } from './chat/branches.js'
import type { Message, Session } from './chat/types.js'

/** 自建后端的输入上限；DeepSeek 云端的输入上限 */
export const CONTEXT_LIMIT_LOCAL = 262144
export const CONTEXT_LIMIT_CLOUD = 1048576

/** 近似值：中文约 1 token/字，英文约 3.6 字符/token；附件按固定开销估算 */
const FILE_TOKENS_IMAGE = 900
const FILE_TOKENS_DOC = 1600
const SYSTEM_TOKENS = 160

export const estimateTextTokens = (text: string): number => {
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) {
      ascii++
    } else {
      wide++
    }
  }
  return Math.ceil(ascii / 3.6 + wide * 1.05)
}

const messageTokens = (message: Message): number => {
  if (message.role === 'user') {
    let tokens = estimateTextTokens(message.content)
    for (const file of message.files) {
      tokens += file.isImage ? FILE_TOKENS_IMAGE : FILE_TOKENS_DOC
    }
    return tokens
  }
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
    .join('')
  return estimateTextTokens(text)
}

/** 当前会真正发给模型的上下文估算；不含已被摘要覆盖的历史与思考/工具块 */
export const getContextUsage = (
  session: Session | undefined,
  draft = '',
  applySummary = true
): number => {
  if (!session) {
    return 0
  }
  const path = getVisibleMessages(session)
  const history = applySummary ? dropCompressed(path, session) : path
  let used = SYSTEM_TOKENS + estimateTextTokens(draft)
  if (applySummary && session.summary) {
    used += estimateTextTokens(session.summary.text) + 40
  }
  for (const message of history) {
    used += messageTokens(message)
  }
  return used
}

export const contextLimitForMode = (
  mode: 'cloud' | 'local',
  localLimit = CONTEXT_LIMIT_LOCAL
): number => (mode === 'local' ? localLimit : CONTEXT_LIMIT_CLOUD)

export const formatTokens = (tokens: number): string => {
  if (tokens >= 1048576) {
    return `${(tokens / 1048576).toFixed(1).replace(/\.0$/, '')}M`
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`
  }
  return String(tokens)
}

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

export type CompressionInput = {
  transcript: string
  cutoffId: string
  count: number
}

/** 保留最近 4 条消息，其余转成文本交给模型压缩；太短时返回 null */
export const buildCompressionInput = (
  session: Session,
  charLimit = 120000
): CompressionInput | null => {
  const path = dropCompressed(getVisibleMessages(session), session)
  const cutoff = Math.max(0, path.length - 4)
  const older = path.slice(0, cutoff)
  if (older.length < 2) {
    return null
  }
  const lines: string[] = []
  for (const message of older) {
    if (message.role === 'user') {
      const content = message.content.trim()
      const files = message.files.length > 0 ? `（附件 ${message.files.length} 个）` : ''
      lines.push(`用户：${truncate(content, 2500)}${files}`)
    } else {
      const text = message.blocks
        .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
        .join('\n')
        .trim()
      if (text) {
        lines.push(`助手：${truncate(text, 2500)}`)
      }
    }
    if (lines.join('\n').length >= charLimit) {
      lines.push('（更早的内容已省略）')
      break
    }
  }
  const transcript = lines.join('\n\n').slice(0, charLimit).trim()
  if (!transcript) {
    return null
  }
  return {
    transcript,
    cutoffId: older[older.length - 1].id,
    count: older.length,
  }
}

export const requestCompression = async (
  transcript: string,
  previousSummary: string
): Promise<string> => {
  const response = await fetch('/api/ai/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Local': '1' },
    body: JSON.stringify({ transcript, previous_summary: previousSummary }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    let message = detail
    try {
      const body = JSON.parse(detail) as { detail?: string }
      message = body.detail || detail
    } catch {
      // 非 JSON 错误体直接展示原文
    }
    throw new Error(message || `压缩失败（${response.status}）`)
  }
  const body = (await response.json()) as { summary?: string }
  if (!body.summary) {
    throw new Error('压缩没有返回摘要')
  }
  return body.summary
}
