import { create } from 'zustand'

/** 后端能力探测：没配置的能力直接隐藏入口，而不是点击后报错。 */
type Capabilities = {
  loaded: boolean
  llm: boolean
  search: boolean
  asr: boolean
  ocr: boolean
  tts: boolean
  contextLimit: number
}

export const useCapabilities = create<Capabilities>(() => ({
  loaded: false,
  llm: true,
  search: true,
  asr: true,
  ocr: true,
  tts: true,
  contextLimit: 262144,
}))

export const loadCapabilities = async (): Promise<void> => {
  try {
    const response = await fetch('/api/health')
    if (!response.ok) {
      return
    }
    const body = (await response.json()) as {
      capabilities?: Partial<Capabilities>
      limits?: { context?: number }
    }
    const caps = body.capabilities
    if (!caps) {
      return
    }
    useCapabilities.setState({
      loaded: true,
      llm: Boolean(caps.llm),
      search: Boolean(caps.search),
      asr: Boolean(caps.asr),
      ocr: Boolean(caps.ocr),
      tts: Boolean(caps.tts),
      contextLimit: Number(body.limits?.context) || 262144,
    })
  } catch {
    // 后端没起来时保持默认值，聊天本身会显示错误
  }
}
