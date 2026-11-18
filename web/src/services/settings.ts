import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 模型来源：云端直连 DeepSeek，或经本机后端走自建模型 */
export type ChatMode = 'cloud' | 'local'

/** 本机设置，存 localStorage：模型来源、API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  mode: ChatMode
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  /** 一次回答里最多的工具调用轮数（本地模式） */
  maxToolRounds: number
  /** 首轮回复完成后用模型生成标题（本地模式） */
  autoTitle: boolean
  siderCollapsed: boolean
}

const KEYS = {
  mode: 'chat-demo:mode',
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  maxToolRounds: 'chat-demo:max-tool-rounds',
  autoTitle: 'chat-demo:auto-title',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialMaxToolRounds = (): number => {
  const raw = read(KEYS.maxToolRounds)
  if (raw === null || raw.trim() === '') {
    return 5
  }
  const value = Number(raw)
  return Number.isFinite(value) ? Math.min(20, Math.max(1, Math.trunc(value))) : 5
}

export const useSettings = create<Settings>(() => ({
  mode: read(KEYS.mode) === 'cloud' ? 'cloud' : 'local',
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  maxToolRounds: initialMaxToolRounds(),
  autoTitle: read(KEYS.autoTitle) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const isLocalMode = () => useSettings.getState().mode === 'local'

export const setMode = (mode: ChatMode) => {
  write(KEYS.mode, mode)
  useSettings.setState({ mode })
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setMaxToolRounds = (maxToolRounds: number) => {
  const value = Math.min(20, Math.max(1, Math.trunc(maxToolRounds)))
  write(KEYS.maxToolRounds, String(value))
  useSettings.setState({ maxToolRounds: value })
}

export const setAutoTitle = (autoTitle: boolean) => {
  write(KEYS.autoTitle, String(autoTitle))
  useSettings.setState({ autoTitle })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
