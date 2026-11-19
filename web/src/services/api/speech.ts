import { ApiError, API_ORIGIN, request } from './client.js'
import { useSettings } from '../settings.js'

/**
 * 语音接口：
 * - ASR：POST /v1/tools/asr，multipart 上传 WAV / Ogg Opus，一次返回全文
 * - TTS：POST /v1/tools/tts，返回音频字节流（产出首帧后即返回 200）
 * 鉴权都用 Authorization: Bearer。
 * 本地模式：ASR 改走本机后端配置的 provider；TTS 暂未实现。
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

export type TtsVoice = 'stella' | 'tide'

/** TTS 裸 PCM 的参数：24kHz、单声道、16-bit 小端（云端与 provider=deepseek 走这一种；带容器的格式由 MIME 判断） */
export const TTS_SAMPLE_RATE = 24000

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal
): Promise<string> => {
  const local = useSettings.getState().mode === 'local'
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const response = await request(local ? '/api/ai/asr' : `${TOOLS_BASE_URL}/asr`, {
    method: 'POST',
    headers: local ? { 'X-Chat-Local': '1' } : { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

/** 云端语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await request(`${TOOLS_BASE_URL}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  return response.body
}

/**
 * 自建后端朗读第一步：本机后端剥掉 markdown、按句切段。
 * 分段是因为朗读接口对单次输入有长度上限，整篇一次塞进去会直接报错。
 */
export const localSpeechPlan = async (text: string, signal: AbortSignal): Promise<string[]> => {
  const response = await request('/api/ai/tts/plan', {
    method: 'POST',
    headers: { 'X-Chat-Local': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  })
  const body = (await response.json()) as { segments?: unknown }
  return Array.isArray(body.segments) ? body.segments.map((item) => String(item ?? '')) : []
}

/** 自建后端朗读第二步：一段文本合成一次，返回音频字节与容器类型（MIME 决定怎么解码） */
export const localSpeechClip = async (
  segment: string,
  signal: AbortSignal
): Promise<{ bytes: ArrayBuffer; mime: string }> => {
  const response = await request('/api/ai/tts', {
    method: 'POST',
    headers: { 'X-Chat-Local': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: segment }),
    signal,
  })
  return { bytes: await response.arrayBuffer(), mime: response.headers.get('content-type') || '' }
}
