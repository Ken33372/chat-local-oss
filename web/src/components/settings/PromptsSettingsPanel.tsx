import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../base/Button.js'
import { IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  loadPrompts,
  savePrompts,
  type PromptCard,
  type PromptsState,
} from '../../services/prompts.js'
import styles from './Settings.module.css'

const MAX_TEXT = 8000
const MAX_CARDS = 30

// 面板关闭/重开也必须等待旧写入，不能只在 UI 上忽略旧响应。
let promptSave: Promise<PromptsState> | undefined
const saveInOrder = (next: PromptsState): Promise<PromptsState> => {
  const task = (promptSave ?? Promise.resolve()).catch(() => {}).then(() => savePrompts(next))
  promptSave = task
  void task
    .finally(() => {
      if (promptSave === task) {
        promptSave = undefined
      }
    })
    .catch(() => {})
  return task
}

const fail = (error: unknown) =>
  showToast({
    key: 'promptFailed',
    params: { message: error instanceof Error ? error.message : String(error) },
    type: 'error',
  })

/** 真正进入 system 的文本；只有它变了才会让已有会话的前缀失效 */
const activeText = (state: PromptsState) =>
  state.cards.find((card) => card.id === state.active)?.text ?? ''

const savedToast = (before: PromptsState, after: PromptsState) =>
  showToast({
    key: activeText(before) === activeText(after) ? 'promptSaved' : 'promptSavedCache',
  })

/** 设置 → 提示词：一张全局生效的角色卡；正文追加在内置规则之后 */
export const PromptsSettingsPanel = () => {
  const t = useTranslate()
  const mode = useSettings((state) => state.mode)
  const local = mode === 'local'
  const [state, setState] = useState<PromptsState | null>(null)
  const [editor, setEditor] = useState<PromptCard | null>(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const operation = useRef(0)
  const [deleteArmed, setDeleteArmed] = useState('')

  useEffect(() => {
    if (!local) {
      return
    }
    let cancelled = false
    const sequence = ++operation.current
    saving.current = true
    setBusy(true)
    void (async () => {
      try {
        await promptSave?.catch(() => {})
        const loaded = await loadPrompts()
        if (!cancelled && sequence === operation.current) {
          setState(loaded)
        }
      } catch (error) {
        if (!cancelled && sequence === operation.current) {
          fail(error)
        }
      } finally {
        if (!cancelled && sequence === operation.current) {
          saving.current = false
          setBusy(false)
        }
      }
    })()
    return () => {
      cancelled = true
      operation.current += 1
    }
  }, [local])

  const persist = async (next: PromptsState) => {
    if (saving.current) {
      return
    }
    const sequence = ++operation.current
    saving.current = true
    setBusy(true)
    const previous = state
    setState(next)
    try {
      const saved = await saveInOrder(next)
      if (sequence !== operation.current) {
        return
      }
      setState(saved)
      if (previous) {
        savedToast(previous, saved)
      }
    } catch (error) {
      if (sequence !== operation.current) {
        return
      }
      setState(previous)
      fail(error)
    } finally {
      if (sequence === operation.current) {
        saving.current = false
        setBusy(false)
      }
    }
  }

  const saveEditor = async () => {
    if (!state || !editor || saving.current) {
      return
    }
    if (!editor.name.trim() || !editor.text.trim()) {
      return
    }
    const sequence = ++operation.current
    saving.current = true
    setBusy(true)
    const before = state
    try {
      const exists = state.cards.some((card) => card.id === editor.id)
      const cards = exists
        ? state.cards.map((card) => (card.id === editor.id ? editor : card))
        : [...state.cards, editor]
      const saved = await saveInOrder({ ...state, cards })
      if (sequence !== operation.current) {
        return
      }
      setState(saved)
      setEditor(null)
      savedToast(before, saved)
    } catch (error) {
      if (sequence !== operation.current) {
        return
      }
      fail(error)
    } finally {
      if (sequence === operation.current) {
        saving.current = false
        setBusy(false)
      }
    }
  }

  const remove = (card: PromptCard) => {
    if (!state || saving.current) {
      return
    }
    if (deleteArmed !== card.id) {
      setDeleteArmed(card.id)
      return
    }
    setDeleteArmed('')
    const cards = state.cards.filter((item) => item.id !== card.id)
    void persist({ cards, active: state.active === card.id ? '' : state.active })
  }

  if (!local) {
    return <div className={styles.memoryNotice}>{t('promptCloudHint')}</div>
  }

  if (!state) {
    return <div className={styles.memoryNotice}>{t('memoryLoading')}</div>
  }

  return (
    <div className={styles.memoryPanel}>
      <div className={styles.memoryHint}>{t('promptScope')}</div>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('promptActive')}</div>
          <div className={styles.description}>{t('promptActiveDescription')}</div>
        </div>
        <Select
          disabled={busy}
          ariaLabel={t('promptActive')}
          value={state.active}
          options={[
            { value: '', label: t('promptNone') },
            ...state.cards.map((card) => ({ value: card.id, label: card.name })),
          ]}
          onChange={(value) => void persist({ ...state, active: value })}
        />
      </div>

      <div className={styles.memorySection}>
        <div className={styles.memorySectionHeader}>
          <div className={styles.memorySectionTitle}>
            {t('promptCards')}
            <span className={styles.memoryCount}>
              {state.cards.length} / {MAX_CARDS}
            </span>
          </div>
          <Button
            size="s"
            variant="outlined"
            disabled={busy || state.cards.length >= MAX_CARDS}
            onClick={() => setEditor({ id: '', name: '', description: '', text: '' })}
          >
            {t('promptAdd')}
          </Button>
        </div>
        <div className={styles.memoryHint}>
          {t('promptLimit', { text: MAX_TEXT, cards: MAX_CARDS })}
        </div>
        {state.cards.length === 0 ? (
          <div className={styles.memoryHint}>{t('promptEmpty')}</div>
        ) : (
          <div className={styles.memoryList}>
            {state.cards.map((card) => (
              <div key={card.id} className={styles.memoryRow}>
                <div className={styles.promptCardBody}>
                  <div className={styles.promptName}>
                    {card.name}
                    {card.id === state.active ? (
                      <span className={styles.promptBadge}>{t('promptInUse')}</span>
                    ) : null}
                  </div>
                  {card.description ? (
                    <div className={styles.promptDescription}>{card.description}</div>
                  ) : null}
                </div>
                <div className={styles.memoryActions}>
                  <button
                    type="button"
                    className={styles.memoryIconButton}
                    disabled={busy}
                    title={t('promptEdit')}
                    onClick={() => setEditor(card)}
                  >
                    <IconEditOutline16 />
                  </button>
                  {deleteArmed === card.id ? (
                    <Button
                      size="s"
                      variant="dangerOutlined"
                      disabled={busy}
                      onClick={() => remove(card)}
                    >
                      {t('promptDeleteArmed')}
                    </Button>
                  ) : (
                    <button
                      type="button"
                      className={styles.memoryIconButton}
                      disabled={busy}
                      title={t('promptDelete')}
                      onClick={() => remove(card)}
                    >
                      <IconTrashOutline16 />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editor ? (
        <Modal
          title={editor.id ? t('promptEditorEdit') : t('promptEditorAdd')}
          className={styles.memoryEditor}
          onClose={() => setEditor(null)}
          footer={
            <div className={styles.memoryEditorActions}>
              <Button variant="outlined" onClick={() => setEditor(null)}>
                {t('memoryCancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !editor.name.trim() || !editor.text.trim()}
                onClick={() => void saveEditor()}
              >
                {t('memorySave')}
              </Button>
            </div>
          }
        >
          <div className={styles.promptField}>
            <span className={styles.promptFieldLabel}>{t('promptName')}</span>
            <input
              className={styles.promptInput}
              value={editor.name}
              maxLength={40}
              placeholder={t('promptNamePlaceholder')}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
          </div>
          <div className={styles.promptField}>
            <span className={styles.promptFieldLabel}>{t('promptDescription')}</span>
            <input
              className={styles.promptInput}
              value={editor.description}
              maxLength={200}
              placeholder={t('promptDescriptionPlaceholder')}
              onChange={(event) => setEditor({ ...editor, description: event.target.value })}
            />
          </div>
          <div className={styles.promptField}>
            <span className={styles.promptFieldLabel}>{t('promptText')}</span>
            <textarea
              className={styles.memoryTextarea}
              rows={8}
              maxLength={MAX_TEXT}
              value={editor.text}
              placeholder={t('promptTextPlaceholder')}
              onChange={(event) => setEditor({ ...editor, text: event.target.value })}
            />
          </div>
          <div className={styles.memoryEditorMeta}>
            <span />
            <span>
              {editor.text.length} / {MAX_TEXT}
            </span>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
