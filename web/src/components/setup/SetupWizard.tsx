import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  loadSetupStatus,
  saveSetup,
  testSetup,
  useSetupWizard,
  type SetupBody,
  type SetupStatus,
} from '../../services/setup.js'
import { loadCapabilities } from '../../services/capabilities.js'
import { setMode } from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './SetupWizard.module.css'

const DISMISSED = 'chat-local:setup-dismissed'

type StepKey = 'mode' | 'llm' | 'search' | 'parsing' | 'voice' | 'extra'
type FeatureKey = 'search' | 'parsing' | 'voice' | 'extra'

type Form = {
  llmProvider: string
  baseUrl: string
  apiKey: string
  llmHeaders: string
  model: string
  contextLimit: string
  maxOutput: string
  searchProvider: string
  searchBase: string
  searchKey: string
  searchResults: string
  asrProvider: string
  asrBase: string
  asrKey: string
  asrModel: string
  imageParser: string
  docParser: string
  ocrOpenaiBase: string
  ocrOpenaiKey: string
  ocrOpenaiModel: string
  ocrDeepseekBase: string
  ocrDeepseekKey: string
  ocrDeepseekModel: string
  rerankBase: string
  rerankKey: string
  rerankModel: string
  embeddingBase: string
  embeddingKey: string
  embeddingModel: string
  embeddingDim: string
  ttsProvider: string
  ttsBase: string
  ttsKey: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: string
}

const emptyForm: Form = {
  llmProvider: 'anthropic',
  baseUrl: '',
  apiKey: '',
  llmHeaders: '',
  model: '',
  contextLimit: '131072',
  maxOutput: '8192',
  searchProvider: 'none',
  searchBase: '',
  searchKey: '',
  searchResults: '6',
  asrProvider: 'none',
  asrBase: '',
  asrKey: '',
  asrModel: 'whisper-1',
  imageParser: 'vision',
  docParser: 'python',
  ocrOpenaiBase: '',
  ocrOpenaiKey: '',
  ocrOpenaiModel: 'gpt-4o-mini',
  ocrDeepseekBase: '',
  ocrDeepseekKey: '',
  ocrDeepseekModel: '',
  rerankBase: '',
  rerankKey: '',
  rerankModel: '',
  embeddingBase: '',
  embeddingKey: '',
  embeddingModel: '',
  embeddingDim: '',
  ttsProvider: 'none',
  ttsBase: '',
  ttsKey: '',
  ttsModel: 'tts-1',
  ttsVoice: '',
  ttsFormat: 'wav',
}

const formFromStatus = (status: SetupStatus): Form => ({
  llmProvider: status.llm.provider ?? 'anthropic',
  baseUrl: status.llm.base_url,
  apiKey: '',
  llmHeaders: '',
  model: status.llm.model,
  contextLimit: String(status.llm.context_limit),
  maxOutput: String(status.llm.max_output_tokens),
  searchProvider: status.search.provider,
  searchBase: status.search.base_url,
  searchKey: '',
  searchResults: String(status.search.results),
  asrProvider: status.asr.provider,
  asrBase: status.asr.base_url,
  asrKey: '',
  asrModel: status.asr.model,
  imageParser: status.parsing?.image ?? 'vision',
  docParser: status.parsing?.document ?? 'python',
  ocrOpenaiBase: status.ocr_openai?.base_url ?? '',
  ocrOpenaiKey: '',
  ocrOpenaiModel: status.ocr_openai?.model ?? 'gpt-4o-mini',
  ocrDeepseekBase: status.ocr_deepseek?.base_url ?? '',
  ocrDeepseekKey: '',
  ocrDeepseekModel: status.ocr_deepseek?.model ?? '',
  rerankBase: status.rerank?.base_url ?? '',
  rerankKey: '',
  rerankModel: status.rerank?.model ?? '',
  embeddingBase: status.embedding?.base_url ?? '',
  embeddingKey: '',
  embeddingModel: status.embedding?.model ?? '',
  embeddingDim: status.embedding?.dim ? String(status.embedding.dim) : '',
  ttsProvider: status.tts?.provider ?? 'none',
  ttsBase: status.tts?.base_url ?? '',
  ttsKey: '',
  ttsModel: status.tts?.model ?? 'tts-1',
  ttsVoice: status.tts?.voice ?? '',
  ttsFormat: status.tts?.response_format ?? 'wav',
})

/** null 表示沿用已保存的 key；空白输入不会把已有 key 清掉。 */
const keepKey = (value: string, hasKey: boolean): string | null =>
  value === '' && hasKey ? null : value

const bodyFrom = (form: Form, status: SetupStatus | null): SetupBody => ({
  llm: {
    provider: form.llmProvider,
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    api_key: keepKey(form.apiKey, status?.llm.has_key ?? false),
    headers:
      form.llmHeaders.trim() === '' && (status?.llm.header_names?.length ?? 0) > 0
        ? null
        : form.llmHeaders.trim(),
    context_limit: Number(form.contextLimit) || 131072,
    max_output_tokens: Number(form.maxOutput) || 8192,
  },
  search: {
    provider: form.searchProvider,
    base_url: form.searchBase.trim(),
    api_key: keepKey(form.searchKey, status?.search.has_key ?? false),
    results: Number(form.searchResults) || 6,
  },
  asr: {
    provider: form.asrProvider,
    base_url: form.asrBase.trim(),
    api_key: keepKey(form.asrKey, status?.asr.has_key ?? false),
    model: form.asrModel.trim(),
  },
  parsing: { image: form.imageParser, document: form.docParser },
  ocr_openai: {
    base_url: form.ocrOpenaiBase.trim(),
    api_key: keepKey(form.ocrOpenaiKey, status?.ocr_openai?.has_key ?? false),
    model: form.ocrOpenaiModel.trim(),
  },
  ocr_deepseek: {
    base_url: form.ocrDeepseekBase.trim(),
    api_key: keepKey(form.ocrDeepseekKey, status?.ocr_deepseek?.has_key ?? false),
    model: form.ocrDeepseekModel.trim(),
  },
  rerank: {
    // 填了 Base URL 就算启用：重排只有 OpenAI 兼容 /v1/rerank 这一种形态
    provider: form.rerankBase.trim() ? 'openai' : 'none',
    base_url: form.rerankBase.trim(),
    api_key: keepKey(form.rerankKey, status?.rerank?.has_key ?? false),
    model: form.rerankModel.trim(),
  },
  embedding: {
    provider: form.embeddingBase.trim() ? 'openai' : 'none',
    base_url: form.embeddingBase.trim(),
    api_key: keepKey(form.embeddingKey, status?.embedding?.has_key ?? false),
    model: form.embeddingModel.trim(),
    dim: Number(form.embeddingDim) || 0,
  },
  tts: {
    provider: form.ttsProvider,
    base_url: form.ttsBase.trim(),
    api_key: keepKey(form.ttsKey, status?.tts?.has_key ?? false),
    model: form.ttsModel.trim(),
    voice: form.ttsVoice.trim(),
    response_format: form.ttsFormat,
  },
})

const ProviderSelect = ({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled: boolean
}) => (
  <label className={styles.field}>
    <span className={styles.label}>{label}</span>
    <Select
      className={styles.input}
      ariaLabel={label}
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
    />
  </label>
)

/** 首次运行配置向导；也可从设置里重新打开修改。 */
export const SetupWizard = () => {
  const t = useTranslate()
  const open = useSetupWizard((state) => state.open)
  const closeWizard = useSetupWizard((state) => state.closeWizard)
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [form, setForm] = useState<Form>(emptyForm)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [step, setStep] = useState<StepKey>('mode')
  const [featureOpen, setFeatureOpen] = useState(false)
  const [picked, setPicked] = useState<Record<FeatureKey, boolean>>({
    search: false,
    parsing: false,
    voice: false,
    extra: false,
  })
  const [enabled, setEnabled] = useState<FeatureKey[]>([])

  useEffect(() => {
    let cancelled = false
    loadSetupStatus()
      .then((next) => {
        if (cancelled) {
          return
        }
        if (!next.configured && !sessionStorage.getItem(DISMISSED)) {
          useSetupWizard.getState().openWizard()
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setMessage(null)
    setStep('mode')
    setEnabled([])
    setFeatureOpen(false)
    setPicked({ search: false, parsing: false, voice: false, extra: false })
    loadSetupStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next)
          setForm(formFromStatus(next))
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage({ text: String(error), error: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) {
    return null
  }

  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const dismiss = () => {
    sessionStorage.setItem(DISMISSED, '1')
    closeWizard()
  }

  const useCloud = () => {
    setMode('cloud')
    sessionStorage.setItem(DISMISSED, '1')
    closeWizard()
    openSettings('data')
    showToast({ key: 'setupCloudNeedsKey' })
  }

  const runTest = async () => {
    if (!form.baseUrl.trim() || !form.model.trim()) {
      setMessage({ text: t('setupRequired'), error: true })
      return
    }
    setTesting(true)
    setMessage(null)
    try {
      const result = await testSetup(bodyFrom(form, status))
      if (result.ok) {
        setMessage({
          text:
            result.models.length > 0
              ? t('setupTestOkModels', { models: result.models.slice(0, 5).join(', ') })
              : t('setupTestOk'),
          error: false,
        })
      } else {
        setMessage({
          text: t('setupTestFail', { message: result.detail || `HTTP ${result.status}` }),
          error: true,
        })
      }
    } catch (error) {
      setMessage({ text: t('setupTestFail', { message: String(error) }), error: true })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!form.baseUrl.trim() || !form.model.trim()) {
      setMessage({ text: t('setupRequired'), error: true })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await saveSetup(bodyFrom(form, status))
      await loadCapabilities()
      sessionStorage.setItem(DISMISSED, '1')
      closeWizard()
      showToast({ key: 'setupDone' })
    } catch (error) {
      setMessage({ text: t('setupSaveFailed', { message: String(error) }), error: true })
    } finally {
      setSaving(false)
    }
  }

  const sequence: StepKey[] = ['mode', 'llm', ...enabled]
  const current = Math.max(0, sequence.indexOf(step))
  const isLast = step !== 'mode' && step !== 'llm' && current === sequence.length - 1

  const go = (delta: number) => {
    const index = sequence.indexOf(step)
    const target = sequence[Math.min(sequence.length - 1, Math.max(0, index + delta))]
    if (target) {
      setMessage(null)
      setStep(target)
    }
  }

  const nextAfterLlm = () => {
    if (!form.baseUrl.trim() || !form.model.trim()) {
      setMessage({ text: t('setupRequired'), error: true })
      return
    }
    setFeatureOpen(true)
  }

  const startFeatures = () => {
    const list = (['search', 'parsing', 'voice', 'extra'] as FeatureKey[]).filter(
      (key) => picked[key]
    )
    setEnabled(list)
    setFeatureOpen(false)
    if (list.length === 0) {
      void save()
      return
    }
    setStep(list[0])
  }

  const skip = () => {
    if (isLast) {
      void save()
      return
    }
    go(1)
  }

  const disabled = saving || testing || status?.writable === false
  const keyPlaceholder = status?.llm.has_key ? t('setupApiKeySaved') : ''
  const searchOptions = [
    { value: 'none', label: t('setupProviderNone') },
    { value: 'anysearch', label: 'AnySearch' },
    { value: 'tavily', label: 'Tavily' },
    { value: 'searxng', label: 'SearXNG' },
  ]
  const toolOptions = [
    { value: 'none', label: t('setupProviderNone') },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'openai', label: t('setupProviderOpenaiCompat') },
  ]
  const imageOptions = [
    { value: 'vision', label: t('setupImageVision') },
    { value: 'openai', label: t('setupImageOpenai') },
    { value: 'deepseek', label: 'DeepSeek' },
  ]
  const docOptions = [
    { value: 'python', label: t('setupDocPython') },
    { value: 'deepseek', label: 'DeepSeek' },
  ]
  // 朗读的 provider 比 ASR/OCR 多一档 engine：用 engine 字段选模型的那类推理服务
  const ttsOptions = [
    ...toolOptions,
    { value: 'engine', label: t('setupTtsEngineOption') },
  ]
  // 朗读返回容器：wav/mp3/opus 带容器头，浏览器自己判采样率；pcm 是裸流，按 24 kHz 处理
  const formatOptions = ['wav', 'mp3', 'opus', 'pcm'].map((value) => ({ value, label: value }))

  const openaiOcrFields = (
    <>
      <p className={styles.hint}>{t('setupOcrOpenaiHint')}</p>
      <label className={styles.field}>
        <span className={styles.label}>Base URL</span>
        <input
          className={styles.input}
          value={form.ocrOpenaiBase}
          disabled={disabled}
          onChange={(event) => update('ocrOpenaiBase', event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>API Key</span>
        <input
          className={styles.input}
          type="password"
          value={form.ocrOpenaiKey}
          disabled={disabled}
          placeholder={status?.ocr_openai?.has_key ? t('setupApiKeySaved') : ''}
          onChange={(event) => update('ocrOpenaiKey', event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t('setupModel')}</span>
        <input
          className={styles.input}
          value={form.ocrOpenaiModel}
          disabled={disabled}
          onChange={(event) => update('ocrOpenaiModel', event.target.value)}
        />
      </label>
    </>
  )

  const deepseekOcrFields = (
    <>
      <p className={styles.hint}>{t('setupOcrDeepseekHint')}</p>
      <label className={styles.field}>
        <span className={styles.label}>Base URL</span>
        <input
          className={styles.input}
          value={form.ocrDeepseekBase}
          disabled={disabled}
          placeholder="https://api.deepseek.com"
          onChange={(event) => update('ocrDeepseekBase', event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>API Key</span>
        <input
          className={styles.input}
          type="password"
          value={form.ocrDeepseekKey}
          disabled={disabled}
          placeholder={status?.ocr_deepseek?.has_key ? t('setupApiKeySaved') : ''}
          onChange={(event) => update('ocrDeepseekKey', event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t('setupModel')}</span>
        <input
          className={styles.input}
          value={form.ocrDeepseekModel}
          disabled={disabled}
          onChange={(event) => update('ocrDeepseekModel', event.target.value)}
        />
      </label>
    </>
  )

  const titles: Record<StepKey, TranslationKey> = {
    mode: 'setupStepModeTitle',
    llm: 'setupStepLlmTitle',
    search: 'setupStepSearchTitle',
    parsing: 'setupStepParsingTitle',
    voice: 'setupStepVoiceTitle',
    extra: 'setupStepExtraTitle',
  }

  return (
    <>
      <Modal
        title={t('setupTitle')}
        className={styles.dialog}
        mainClassName={styles.body}
        onClose={dismiss}
        footer={
          <div className={styles.footerActions}>
            <Button variant="outlined" size="m" disabled={saving} onClick={dismiss}>
              {t('setupLater')}
            </Button>
            {step !== 'mode' && step !== 'llm' ? (
              <>
                <Button variant="outlined" size="m" disabled={disabled} onClick={() => go(-1)}>
                  {t('setupBack')}
                </Button>
                <Button variant="outlined" size="m" disabled={disabled} onClick={skip}>
                  {t('setupSkip')}
                </Button>
              </>
            ) : null}
            {step === 'llm' ? (
              <Button variant="primary" size="m" disabled={disabled} onClick={nextAfterLlm}>
                {t('setupNext')}
              </Button>
            ) : step === 'mode' ? null : (
              <Button
                variant="primary"
                size="m"
                disabled={disabled}
                onClick={() => (isLast ? void save() : go(1))}
              >
                {saving ? t('setupTesting') : isLast ? t('setupFinish') : t('setupNext')}
              </Button>
            )}
          </div>
        }
      >
        {status?.writable === false ? (
          <div className={styles.warning}>{t('setupUnavailable')}</div>
        ) : null}

        <div className={styles.stepHeader}>
          <div className={styles.stepTitle}>{t(titles[step])}</div>
          <div className={styles.stepMeta}>
            <span className={styles.stepCount}>
              {t('setupStepOf', { current: current + 1, total: sequence.length })}
            </span>
            <span className={styles.stepDots}>
              {sequence.map((key, index) => (
                <span
                  key={key}
                  className={clsx(styles.stepDot, index <= current && styles.stepDotActive)}
                />
              ))}
            </span>
          </div>
        </div>

        {message && step !== 'llm' ? (
          <div className={message.error ? styles.error : styles.success}>{message.text}</div>
        ) : null}

        {step === 'mode' ? (
          <>
            <div className={styles.intro}>{t('setupIntro')}</div>
            <div className={styles.optionGrid}>
              <button type="button" className={styles.optionCard} onClick={useCloud}>
                <span className={styles.optionTitle}>{t('setupModeCloudTitle')}</span>
                <span className={styles.optionDesc}>{t('setupModeCloudDesc')}</span>
              </button>
              <button
                type="button"
                className={clsx(styles.optionCard, styles.optionCardActive)}
                onClick={() => setStep('llm')}
              >
                <span className={styles.optionTitle}>{t('setupModeLocalTitle')}</span>
                <span className={styles.optionDesc}>{t('setupModeLocalDesc')}</span>
              </button>
            </div>
          </>
        ) : null}

        {step === 'llm' ? (
          <div className={styles.form}>
            <ProviderSelect
              label={t('setupLlmProtocol')}
              value={form.llmProvider}
              options={[
                { value: 'anthropic', label: t('setupLlmAnthropic') },
                { value: 'openai', label: t('setupLlmOpenai') },
              ]}
              disabled={disabled}
              onChange={(value) => update('llmProvider', value)}
            />
            <label className={styles.field}>
              <span className={styles.label}>{t('setupBaseUrl')}</span>
              <input
                className={styles.input}
                value={form.baseUrl}
                disabled={disabled}
                placeholder={
                  form.llmProvider === 'openai'
                    ? 'http://127.0.0.1:11434/v1'
                    : 'https://api.deepseek.com/anthropic'
                }
                onChange={(event) => update('baseUrl', event.target.value)}
              />
              <span className={styles.hint}>{t('setupLlmProtocolDesc')}</span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('setupApiKey')}</span>
              <input
                className={styles.input}
                type="password"
                value={form.apiKey}
                disabled={disabled}
                placeholder={keyPlaceholder}
                onChange={(event) => update('apiKey', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('setupModel')}</span>
              <input
                className={styles.input}
                value={form.model}
                disabled={disabled}
                placeholder={form.llmProvider === 'openai' ? 'qwen3:8b' : 'deepseek-flash'}
                onChange={(event) => update('model', event.target.value)}
              />
            </label>
            <div className={styles.testRow}>
              <Button variant="outlined" size="m" disabled={disabled} onClick={() => void runTest()}>
                {testing ? t('setupTesting') : t('setupTest')}
              </Button>
              {message ? (
                <span className={message.error ? styles.error : styles.success}>{message.text}</span>
              ) : null}
            </div>
            <details className={styles.advanced}>
              <summary>{t('setupAdvanced')}</summary>
              <label className={styles.field}>
                <span className={styles.label}>{t('setupLlmHeaders')}</span>
                <input
                  className={styles.input}
                  value={form.llmHeaders}
                  disabled={disabled}
                  placeholder={
                    (status?.llm.header_names?.length ?? 0) > 0
                      ? t('setupLlmHeadersSaved', {
                          names: status?.llm.header_names?.join(', ') ?? '',
                        })
                      : '{"api-key": "{key}"}'
                  }
                  onChange={(event) => update('llmHeaders', event.target.value)}
                />
                <span className={styles.hint}>{t('setupLlmHeadersHint')}</span>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{t('setupContextLimit')}</span>
                <input
                  className={styles.input}
                  type="number"
                  min={1024}
                  value={form.contextLimit}
                  disabled={disabled}
                  onChange={(event) => update('contextLimit', event.target.value)}
                />
                <span className={styles.hint}>{t('setupContextLimitDesc')}</span>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{t('setupMaxOutput')}</span>
                <input
                  className={styles.input}
                  type="number"
                  min={128}
                  value={form.maxOutput}
                  disabled={disabled}
                  onChange={(event) => update('maxOutput', event.target.value)}
                />
                <span className={styles.hint}>{t('setupMaxOutputDesc')}</span>
              </label>
            </details>
          </div>
        ) : null}

        {step === 'search' ? (
          <div className={styles.form}>
            <ProviderSelect
              label={t('setupSearchProvider')}
              value={form.searchProvider}
              options={searchOptions}
              disabled={disabled}
              onChange={(value) => update('searchProvider', value)}
            />
            {form.searchProvider !== 'none' ? (
              <>
                <label className={styles.field}>
                  <span className={styles.label}>Base URL</span>
                  <input
                    className={styles.input}
                    value={form.searchBase}
                    disabled={disabled}
                    onChange={(event) => update('searchBase', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>API Key</span>
                  <input
                    className={styles.input}
                    type="password"
                    value={form.searchKey}
                    disabled={disabled}
                    placeholder={status?.search.has_key ? t('setupApiKeySaved') : ''}
                    onChange={(event) => update('searchKey', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('setupResults')}</span>
                  <input
                    className={styles.input}
                    type="number"
                    min={1}
                    max={12}
                    value={form.searchResults}
                    disabled={disabled}
                    onChange={(event) => update('searchResults', event.target.value)}
                  />
                  <span className={styles.hint}>{t('setupResultsDesc')}</span>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {step === 'parsing' ? (
          <div className={styles.form}>
            <p className={styles.hint}>{t('setupParsingHint')}</p>
            <ProviderSelect
              label={t('setupImageParsing')}
              value={form.imageParser}
              options={imageOptions}
              disabled={disabled}
              onChange={(value) => update('imageParser', value)}
            />
            {form.imageParser === 'openai' ? openaiOcrFields : null}
            {form.imageParser === 'deepseek' && form.docParser !== 'deepseek'
              ? deepseekOcrFields
              : null}
            <ProviderSelect
              label={t('setupDocParsing')}
              value={form.docParser}
              options={docOptions}
              disabled={disabled}
              onChange={(value) => update('docParser', value)}
            />
            {form.docParser === 'deepseek' ? deepseekOcrFields : null}
          </div>
        ) : null}

        {step === 'voice' ? (
          <div className={styles.form}>
            <div className={styles.stepSection}>{t('setupAsrSection')}</div>
            <ProviderSelect
              label={t('setupAsrProvider')}
              value={form.asrProvider}
              options={toolOptions}
              disabled={disabled}
              onChange={(value) => update('asrProvider', value)}
            />
            {form.asrProvider !== 'none' ? (
              <>
                <label className={styles.field}>
                  <span className={styles.label}>Base URL</span>
                  <input
                    className={styles.input}
                    value={form.asrBase}
                    disabled={disabled}
                    onChange={(event) => update('asrBase', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>API Key</span>
                  <input
                    className={styles.input}
                    type="password"
                    value={form.asrKey}
                    disabled={disabled}
                    placeholder={status?.asr.has_key ? t('setupApiKeySaved') : ''}
                    onChange={(event) => update('asrKey', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('setupModel')}</span>
                  <input
                    className={styles.input}
                    value={form.asrModel}
                    disabled={disabled}
                    onChange={(event) => update('asrModel', event.target.value)}
                  />
                </label>
              </>
            ) : null}

            <div className={styles.stepSection}>{t('setupTtsSection')}</div>
            <ProviderSelect
              label={t('setupTtsProvider')}
              value={form.ttsProvider}
              options={ttsOptions}
              disabled={disabled}
              onChange={(value) => update('ttsProvider', value)}
            />
            {form.ttsProvider !== 'none' ? (
              <>
                <p className={styles.hint}>{t('setupTtsHint')}</p>
                <label className={styles.field}>
                  <span className={styles.label}>Base URL</span>
                  <input
                    className={styles.input}
                    value={form.ttsBase}
                    disabled={disabled}
                    placeholder={
                      form.ttsProvider === 'engine'
                        ? 'http://127.0.0.1:8090/api/tts/speech'
                        : 'http://127.0.0.1:8000/v1'
                    }
                    onChange={(event) => update('ttsBase', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>API Key</span>
                  <input
                    className={styles.input}
                    type="password"
                    value={form.ttsKey}
                    disabled={disabled}
                    placeholder={status?.tts?.has_key ? t('setupApiKeySaved') : ''}
                    onChange={(event) => update('ttsKey', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>
                    {form.ttsProvider === 'engine' ? t('setupTtsEngine') : t('setupModel')}
                  </span>
                  <input
                    className={styles.input}
                    value={form.ttsModel}
                    disabled={disabled}
                    onChange={(event) => update('ttsModel', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('setupTtsVoice')}</span>
                  <input
                    className={styles.input}
                    value={form.ttsVoice}
                    disabled={disabled}
                    placeholder={t('setupTtsVoicePlaceholder')}
                    onChange={(event) => update('ttsVoice', event.target.value)}
                  />
                </label>
                <ProviderSelect
                  label={t('setupTtsFormat')}
                  value={form.ttsFormat}
                  options={formatOptions}
                  disabled={disabled}
                  onChange={(value) => update('ttsFormat', value)}
                />
              </>
            ) : null}
          </div>
        ) : null}

        {step === 'extra' ? (
          <div className={styles.form}>
            <div className={styles.stepSection}>{t('setupRerankSection')}</div>
            <p className={styles.hint}>{t('setupRerankHint')}</p>
            <label className={styles.field}>
              <span className={styles.label}>Base URL</span>
              <input
                className={styles.input}
                value={form.rerankBase}
                disabled={disabled}
                placeholder="http://127.0.0.1:8000"
                onChange={(event) => update('rerankBase', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>API Key</span>
              <input
                className={styles.input}
                type="password"
                value={form.rerankKey}
                disabled={disabled}
                placeholder={status?.rerank?.has_key ? t('setupApiKeySaved') : ''}
                onChange={(event) => update('rerankKey', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('setupModel')}</span>
              <input
                className={styles.input}
                value={form.rerankModel}
                disabled={disabled}
                onChange={(event) => update('rerankModel', event.target.value)}
              />
            </label>

            <div className={styles.stepSection}>{t('setupEmbeddingSection')}</div>
            <p className={styles.hint}>{t('setupEmbeddingHint')}</p>
            <label className={styles.field}>
              <span className={styles.label}>Base URL</span>
              <input
                className={styles.input}
                value={form.embeddingBase}
                disabled={disabled}
                placeholder="http://127.0.0.1:8080"
                onChange={(event) => update('embeddingBase', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>API Key</span>
              <input
                className={styles.input}
                type="password"
                value={form.embeddingKey}
                disabled={disabled}
                placeholder={status?.embedding?.has_key ? t('setupApiKeySaved') : ''}
                onChange={(event) => update('embeddingKey', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('setupModel')}</span>
              <input
                className={styles.input}
                value={form.embeddingModel}
                disabled={disabled}
                placeholder="bge-m3"
                onChange={(event) => update('embeddingModel', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t('setupEmbeddingDim')}</span>
              <input
                className={styles.input}
                type="number"
                min={0}
                max={16384}
                value={form.embeddingDim}
                disabled={disabled}
                placeholder="1024"
                onChange={(event) => update('embeddingDim', event.target.value)}
              />
              <span className={styles.hint}>{t('setupEmbeddingDimHint')}</span>
            </label>
          </div>
        ) : null}
      </Modal>

      {featureOpen ? (
        <Modal
          title={t('setupFeatureTitle')}
          className={styles.featureDialog}
          onClose={() => setFeatureOpen(false)}
          footer={
            <div className={styles.footerActions}>
              <Button variant="outlined" size="m" onClick={() => setFeatureOpen(false)}>
                {t('setupBack')}
              </Button>
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  setFeatureOpen(false)
                  void save()
                }}
              >
                {t('setupFeatureNone')}
              </Button>
              <Button variant="primary" size="m" onClick={startFeatures}>
                {t('setupFeatureStart')}
              </Button>
            </div>
          }
        >
          <p className={styles.hint}>{t('setupFeatureDesc')}</p>
          <div className={styles.featureTools}>
            <button
              type="button"
              className={styles.featureAll}
              onClick={() =>
                setPicked(
                  picked.search && picked.parsing && picked.voice && picked.extra
                    ? { search: false, parsing: false, voice: false, extra: false }
                    : { search: true, parsing: true, voice: true, extra: true }
                )
              }
            >
              {picked.search && picked.parsing && picked.voice && picked.extra
                ? t('setupFeatureClear')
                : t('setupFeatureAll')}
            </button>
          </div>
          <div className={styles.featureList}>
            {(
              [
                ['search', 'setupFeatureSearch'],
                ['parsing', 'setupFeatureParsing'],
                ['voice', 'setupFeatureVoice'],
                ['extra', 'setupFeatureExtra'],
              ] as [FeatureKey, TranslationKey][]
            ).map(([key, label]) => (
              <label key={key} className={styles.featureItem}>
                <input
                  type="checkbox"
                  checked={picked[key]}
                  onChange={(event) => setPicked({ ...picked, [key]: event.target.checked })}
                />
                <span className={styles.featureName}>{t(label)}</span>
              </label>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  )
}
