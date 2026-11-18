import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
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

type Form = {
  baseUrl: string
  apiKey: string
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
  ocrProvider: string
  ocrBase: string
  ocrKey: string
  ocrModel: string
}

const emptyForm: Form = {
  baseUrl: '',
  apiKey: '',
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
  ocrProvider: 'none',
  ocrBase: '',
  ocrKey: '',
  ocrModel: 'gpt-4o-mini',
}

const formFromStatus = (status: SetupStatus): Form => ({
  baseUrl: status.llm.base_url,
  apiKey: '',
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
  ocrProvider: status.ocr.provider,
  ocrBase: status.ocr.base_url,
  ocrKey: '',
  ocrModel: status.ocr.model,
})

/** null 表示沿用已保存的 key；空白输入不会把已有 key 清掉。 */
const keepKey = (value: string, hasKey: boolean): string | null =>
  value === '' && hasKey ? null : value

const bodyFrom = (form: Form, status: SetupStatus | null): SetupBody => ({
  llm: {
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    api_key: keepKey(form.apiKey, status?.llm.has_key ?? false),
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
  ocr: {
    provider: form.ocrProvider,
    base_url: form.ocrBase.trim(),
    api_key: keepKey(form.ocrKey, status?.ocr.has_key ?? false),
    model: form.ocrModel.trim(),
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
  const [mode, setWizardMode] = useState<'local' | 'cloud'>('local')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

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
    openSettings('general')
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
    { value: 'openai', label: 'OpenAI 兼容' },
  ]

  return (
    <Modal
      title={t('setupTitle')}
      className={styles.dialog}
      onClose={dismiss}
      footer={
        <>
          <Button variant="outlined" size="m" disabled={saving} onClick={dismiss}>
            {t('setupLater')}
          </Button>
          <Button
            variant="primary"
            size="m"
            disabled={disabled || mode === 'cloud'}
            onClick={() => void save()}
          >
            {saving ? t('setupTesting') : t('setupSave')}
          </Button>
        </>
      }
    >
      <div className={styles.intro}>{t('setupIntro')}</div>
      <div className={styles.modes} role="radiogroup" aria-label={t('setupTitle')}>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'local'}
          className={mode === 'local' ? styles.modeActive : styles.mode}
          onClick={() => setWizardMode('local')}
        >
          {t('setupSelfHosted')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'cloud'}
          className={mode === 'cloud' ? styles.modeActive : styles.mode}
          onClick={() => setWizardMode('cloud')}
        >
          {t('setupCloud')}
        </button>
      </div>

      {status?.writable === false ? (
        <div className={styles.warning}>{t('setupUnavailable')}</div>
      ) : null}

      {mode === 'cloud' ? (
        <div className={styles.cloudBox}>
          <div>{t('setupCloudDesc')}</div>
          <Button variant="outlined" size="m" onClick={useCloud}>
            {t('setupCloudAction')}
          </Button>
        </div>
      ) : (
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>{t('setupBaseUrl')}</span>
            <input
              className={styles.input}
              value={form.baseUrl}
              disabled={disabled}
              placeholder="http://127.0.0.1:8000"
              onChange={(event) => update('baseUrl', event.target.value)}
            />
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
              placeholder="deepseek-flash"
              onChange={(event) => update('model', event.target.value)}
            />
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
                    placeholder={
                      status?.search.has_key ? t('setupApiKeySaved') : ''
                    }
                    onChange={(event) => update('searchKey', event.target.value)}
                  />
                </label>
              </>
            ) : null}
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
            <ProviderSelect
              label={t('setupOcrProvider')}
              value={form.ocrProvider}
              options={toolOptions}
              disabled={disabled}
              onChange={(value) => update('ocrProvider', value)}
            />
            {form.ocrProvider !== 'none' ? (
              <>
                <label className={styles.field}>
                  <span className={styles.label}>Base URL</span>
                  <input
                    className={styles.input}
                    value={form.ocrBase}
                    disabled={disabled}
                    onChange={(event) => update('ocrBase', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>API Key</span>
                  <input
                    className={styles.input}
                    type="password"
                    value={form.ocrKey}
                    disabled={disabled}
                    placeholder={status?.ocr.has_key ? t('setupApiKeySaved') : ''}
                    onChange={(event) => update('ocrKey', event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('setupModel')}</span>
                  <input
                    className={styles.input}
                    value={form.ocrModel}
                    disabled={disabled}
                    onChange={(event) => update('ocrModel', event.target.value)}
                  />
                </label>
              </>
            ) : null}
          </details>
        </div>
      )}
    </Modal>
  )
}
