import { translate, type TranslationMessage } from '../../i18n/index.js'
import { useSettings } from '../settings.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    } else if (
      typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof (body as { detail?: unknown }).detail === 'string'
    ) {
      // 本机后端的 FastAPI 错误体
      message = (body as { detail: string }).detail
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${API_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/** 本机后端只接受它需要的字段；DeepSeek 私有字段（safety_check、title、latest_reminder）由后端处理 */
export type StreamSettings = Pick<ReturnType<typeof useSettings.getState>, 'mode' | 'maxToolRounds'>

const toLocalBody = (body: CreateMessageRequest, settings: StreamSettings, sessionId?: string) => ({
  model: body.model,
  system: body.system,
  messages: body.messages,
  thinking: body.thinking.type === 'enabled',
  search: body.tools.some((tool) => tool.type === 'deepseek_web_search'),
  max_tool_rounds: settings.maxToolRounds,
  ...(body.context_summary ? { context_summary: body.context_summary } : {}),
  // 后端用它填 {session} 请求头，供要求稳定会话 ID 的服务做路由与缓存
  ...(sessionId ? { session_id: sessionId } : {}),
})

const consumeMessageStream = async function* (
  response: Response,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

/** 本地模式：经本机后端转发到已配置的模型接口，SSE 事件与云端保持一致。
 * 图片默认先按视觉发送；引擎显存准入拒绝时后端给 VISION_UNAVAILABLE 前缀，这里自动改用 OCR 重试一次。 */
const VISION_UNAVAILABLE = 'VISION_UNAVAILABLE|'

const streamLocalMessage = async function* (
  body: CreateMessageRequest,
  signal: AbortSignal,
  settings: StreamSettings,
  sessionId?: string
): AsyncGenerator<MessageStreamEvent> {
  const run = async function* (imageMode?: 'ocr'): AsyncGenerator<MessageStreamEvent> {
    const response = await request('/api/ai/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Local': '1',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        ...toLocalBody(body, settings, sessionId),
        ...(imageMode ? { image_mode: imageMode } : {}),
      }),
      signal,
    })
    yield* consumeMessageStream(response, signal)
  }
  try {
    yield* run()
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.message.startsWith(VISION_UNAVAILABLE) &&
      !signal.aborted
    ) {
      yield* run('ocr')
      return
    }
    throw error
  }
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * 本地模式改由本机后端代理；其余行为与云端一致。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  sessionId?: string,
  settings: StreamSettings = useSettings.getState()
): AsyncGenerator<MessageStreamEvent> {
  if (settings.mode === 'local') {
    yield* streamLocalMessage(body, signal, settings, sessionId)
    return
  }
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  yield* consumeMessageStream(response, signal)
}
