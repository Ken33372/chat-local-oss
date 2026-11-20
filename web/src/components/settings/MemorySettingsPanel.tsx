import clsx from 'clsx'
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { IconCloseOutline16, IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { loadSetupStatus } from '../../services/setup.js'
import {
  acceptProposal,
  addMemory,
  clearMemories,
  deleteMemory,
  exportMemories,
  loadTidy,
  mergeMemories,
  importMemories,
  loadMemoryItems,
  loadProposals,
  rejectProposal,
  saveMemorySettings,
  updateMemory,
  useMemoryStore,
  type MemoryItem,
  type MemoryProposal,
  type MemorySettings,
  type MemoryTidyPair,
} from '../../services/memory.js'
import styles from './Settings.module.css'

const fail = (error: unknown) =>
  showToast({
    key: 'memoryFailedWithReason',
    params: { message: error instanceof Error ? error.message : String(error) },
    type: 'error',
  })

const DEFAULT_SETTINGS: MemorySettings = {
  enabled: false,
  inject: 'recent',
  inject_mode: 'recent',
  search_mode: 'score',
  inject_count: 5,
  tools: true,
  write: 'propose',
}

/** 设置 → 记忆：开关在前，待确认与已保存条目在后；改动即时保存 */
export const MemorySettingsPanel = () => {
  const t = useTranslate()
  const mode = useSettings((state) => state.mode)
  const local = mode === 'local'
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [proposals, setProposals] = useState<MemoryProposal[]>([])
  const [editor, setEditor] = useState<{
    id: number | null
    text: string
    description: string
    pinned: boolean
  } | null>(null)
  const [limits, setLimits] = useState({ text: 100, items: 200 })
  const [embeddingReady, setEmbeddingReady] = useState(false)
  const [embeddingError, setEmbeddingError] = useState('')
  const [busy, setBusy] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const [tidy, setTidy] = useState<MemoryTidyPair[]>([])
  const [tidyBusy, setTidyBusy] = useState(false)
  const refreshPending = useMemoryStore((state) => state.refresh)
  const importRef = useRef<HTMLInputElement>(null)

  const reload = async () => {
    const [itemList, proposalList] = await Promise.all([loadMemoryItems(), loadProposals()])
    setItems(itemList)
    setProposals(proposalList)
    await refreshPending()
  }

  useEffect(() => {
    if (!local) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const status = await loadSetupStatus()
        if (cancelled) {
          return
        }
        setSettings(status.memory ?? DEFAULT_SETTINGS)
        if (status.memory?.limits) {
          setLimits(status.memory.limits)
        }
        setEmbeddingReady(Boolean(status.capabilities.embedding))
        setEmbeddingError(status.memory?.embedding_error ?? '')
        await reload()
      } catch (error) {
        if (!cancelled) {
          fail(error)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local])

  const patch = async (next: Partial<MemorySettings>) => {
    if (!settings) {
      return
    }
    const merged = { ...settings, ...next }
    setSettings(merged)
    try {
      await saveMemorySettings(merged)
    } catch (error) {
      fail(error)
      const status = await loadSetupStatus().catch(() => null)
      if (status) {
        setSettings(status.memory ?? merged)
      }
    }
  }

  const saveEditor = async () => {
    if (!editor || busy || !editor.text.trim()) {
      return
    }
    setBusy(true)
    try {
      if (editor.id === null) {
        const item = await addMemory(editor.text.trim(), editor.pinned, editor.description.trim())
        setItems((current) => [item, ...current])
        showToast({ key: 'memoryAdded' })
      } else {
        const updated = await updateMemory(
          editor.id,
          editor.text.trim(),
          editor.pinned,
          editor.description.trim()
        )
        setItems((current) => current.map((row) => (row.id === updated.id ? updated : row)))
      }
      setEditor(null)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (item: MemoryItem) => {
    try {
      const updated = await updateMemory(item.id, item.text, !item.pinned)
      setItems((current) => current.map((row) => (row.id === updated.id ? updated : row)))
    } catch (error) {
      fail(error)
    }
  }

  const remove = async (id: number) => {
    try {
      await deleteMemory(id)
      setItems((current) => current.filter((item) => item.id !== id))
    } catch (error) {
      fail(error)
    }
  }

  const runTidy = async () => {
    setTidyBusy(true)
    try {
      const pairs = await loadTidy()
      setTidy(pairs)
      if (pairs.length === 0) {
        showToast({ key: 'memoryTidyEmpty' })
      }
    } catch (error) {
      fail(error)
    } finally {
      setTidyBusy(false)
    }
  }

  const merge = async (keep: number, drop: number) => {
    try {
      await mergeMemories(keep, drop)
      setTidy((current) =>
        current.filter((pair) => pair.a.id !== drop && pair.b.id !== drop)
      )
      setItems(await loadMemoryItems())
      showToast({ key: 'memoryTidyMerged' })
    } catch (error) {
      fail(error)
    }
  }

  const accept = async (id: number) => {
    try {
      await acceptProposal(id)
      setProposals((current) => current.filter((item) => item.id !== id))
      const itemList = await loadMemoryItems()
      setItems(itemList)
      await refreshPending()
    } catch (error) {
      fail(error)
    }
  }

  const reject = async (id: number) => {
    try {
      await rejectProposal(id)
      setProposals((current) => current.filter((item) => item.id !== id))
      await refreshPending()
    } catch (error) {
      fail(error)
    }
  }

  const exportAll = async () => {
    try {
      const text = await exportMemories()
      const blob = new Blob([text || t('memoryEmpty')], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'memory.txt'
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      fail(error)
    }
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    try {
      const result = await importMemories(await file.text())
      setItems(await loadMemoryItems())
      showToast({ key: 'memoryImported', params: { added: result.added, skipped: result.skipped } })
    } catch (error) {
      fail(error)
    }
  }

  const clear = async () => {
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    setClearArmed(false)
    try {
      await clearMemories()
      setItems([])
      setProposals([])
      await refreshPending()
      showToast({ key: 'memoryCleared' })
    } catch (error) {
      fail(error)
    }
  }

  if (!local) {
    return <div className={styles.memoryNotice}>{t('memoryCloudHint')}</div>
  }

  if (!settings) {
    return <div className={styles.memoryNotice}>{t('memoryLoading')}</div>
  }

  const enabled = settings.enabled

  return (
    <div className={styles.memoryPanel}>
      <Cell
        label={t('memoryEnabled')}
        description={t('memoryEnabledDescription')}
        action={<Switch checked={enabled} label={t('memoryEnabled')} onChange={() => void patch({ enabled: !enabled })} />}
      />
      {proposals.length > 0 ? (
        <div className={styles.memorySection}>
          <div className={styles.memorySectionTitle}>
            {t('memoryPending')} · {proposals.length}
          </div>
          <div className={styles.memoryList}>
            {proposals.map((proposal) => (
              <div key={proposal.id} className={clsx(styles.memoryRow, styles.memoryRowPending)}>
                <div className={styles.memoryProposalBody}>
                  {proposal.kind === 'edit' && proposal.oldText ? (
                    <span className={styles.memoryTextOld}>{proposal.oldText}</span>
                  ) : null}
                  <span className={styles.memoryText}>{proposal.text}</span>
                  {proposal.description ? (
                    <span className={styles.memoryDescription}>{proposal.description}</span>
                  ) : null}
                </div>
                <div className={styles.memoryActions}>
                  <Button size="m" variant="outlined" onClick={() => void accept(proposal.id)}>
                    {t('memoryAccept')}
                  </Button>
                  <Button size="m" variant="outlined" onClick={() => void reject(proposal.id)}>
                    {t('memoryReject')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {enabled ? (
        <details className={styles.memorySettings}>
          <summary>{t('memoryAdvanced')}</summary>
        <Cell
          label={t('memoryInject')}
          description={t('memoryInjectDescription')}
          action={
            <Select
              ariaLabel={t('memoryInject')}
              value={settings.inject_mode ?? (settings.inject === 'off' ? 'off' : 'recent')}
              options={[
                { value: 'recent', label: t('memoryInjectRecent') },
                { value: 'keyword', label: t('memoryInjectModeKeyword') },
                { value: 'embedding', label: t('memoryInjectModeEmbedding') },
                { value: 'off', label: t('memoryInjectModeOff') },
              ]}
              onChange={(value) =>
                void patch({
                  inject_mode: value as MemorySettings['inject_mode'],
                  inject: value === 'off' ? 'off' : 'recent',
                })
              }
            />
          }
        />
        {settings.inject_mode !== 'off' ? (
          <Cell
            label={t('memoryCount')}
            description={t('memoryCountDescription')}
            action={
              <Select
                ariaLabel={t('memoryCount')}
                value={String(settings.inject_count)}
                options={[3, 5, 8, 10].map((value) => ({ value: String(value), label: String(value) }))}
                onChange={(value) => void patch({ inject_count: Number(value) })}
              />
            }
          />
        ) : null}
        <Cell
          label={t('memoryTools')}
          description={t('memoryToolsDescription')}
          action={
            <Switch
              checked={settings.tools}
              label={t('memoryTools')}
              onChange={() => void patch({ tools: !settings.tools })}
            />
          }
        />
        <Cell
          label={t('memorySearchMode')}
          description={t('memorySearchModeDescription')}
          action={
            <Select
              ariaLabel={t('memorySearchMode')}
              value={settings.search_mode ?? 'score'}
              options={[
                { value: 'keyword', label: t('memorySearchModeKeyword') },
                { value: 'score', label: t('memorySearchModeScore') },
                { value: 'embedding', label: t('memorySearchModeEmbedding') },
              ]}
              onChange={(value) =>
                void patch({ search_mode: value as MemorySettings['search_mode'] })
              }
            />
          }
        />
        <Cell
          label={t('memoryWrite')}
          description={t('memoryWriteDescription')}
          action={
            <Select
              ariaLabel={t('memoryWrite')}
              value={settings.write}
              options={[
                { value: 'propose', label: t('memoryWritePropose') },
                { value: 'off', label: t('memoryWriteOff') },
              ]}
              onChange={(value) => void patch({ write: value as MemorySettings['write'] })}
            />
          }
        />
        {(settings.inject_mode === 'embedding' || settings.search_mode === 'embedding') &&
        !embeddingReady ? (
          <div className={styles.memoryHint}>{t('memoryEmbeddingMissing')}</div>
        ) : null}
        {embeddingError ? (
          <div className={styles.memoryHint}>
            {t('memoryEmbeddingError', { message: embeddingError })}
          </div>
        ) : null}
        </details>
      ) : null}

      {tidy.length > 0 ? (
        <div className={styles.memorySection}>
          <div className={styles.memorySectionTitle}>
            {t('memoryTidyTitle')} · {tidy.length}
          </div>
          <div className={styles.memoryHint}>{t('memoryTidyHint')}</div>
          <div className={styles.memoryList}>
            {tidy.map((pair) => (
              <div
                key={`${pair.a.id}-${pair.b.id}`}
                className={clsx(styles.memoryRow, styles.memoryRowPending)}
              >
                <div className={styles.memoryProposalBody}>
                  <span className={styles.memoryText}>{pair.a.text}</span>
                  <span className={styles.memoryTextOld}>{pair.b.text}</span>
                  <span className={styles.memoryHint}>
                    {t('memoryTidyScore', { score: Math.round(pair.score * 100) })}
                  </span>
                </div>
                <div className={styles.memoryActions}>
                  <Button size="m" variant="outlined" onClick={() => void merge(pair.a.id, pair.b.id)}>
                    {t('memoryTidyKeepA')}
                  </Button>
                  <Button size="m" variant="outlined" onClick={() => void merge(pair.b.id, pair.a.id)}>
                    {t('memoryTidyKeepB')}
                  </Button>
                  <button
                    type="button"
                    className={styles.memoryIconButton}
                    title={t('memoryTidySkip')}
                    onClick={() =>
                      setTidy((current) =>
                        current.filter((item) => item !== pair)
                      )
                    }
                  >
                    <IconCloseOutline16 />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.memorySection}>
        <div className={styles.memorySectionHeader}>
          <div className={styles.memorySectionTitle}>
            {t('memoryItems')}
            <span className={styles.memoryCount}>
              {items.length} / {limits.items}
            </span>
          </div>
          <div className={styles.memoryActions}>
            <Button
              size="s"
              variant="outlined"
              disabled={items.length < 2 || tidyBusy}
              onClick={() => void runTidy()}
            >
              {t('memoryTidy')}
            </Button>
            <Button
              size="s"
              variant="outlined"
              disabled={items.length >= limits.items}
              onClick={() => setEditor({ id: null, text: '', description: '', pinned: false })}
            >
              {t('memoryAdd')}
            </Button>
          </div>
        </div>
        <div className={styles.memoryHint}>
          {t('memoryLimits', { text: limits.text, items: limits.items })}
        </div>
        {items.length === 0 ? (
          <div className={styles.memoryHint}>{t('memoryEmpty')}</div>
        ) : (
          <div className={styles.memoryList}>
            {items.map((item) => (
              <div key={item.id} className={styles.memoryRow}>
                <button
                  type="button"
                  className={clsx(styles.memoryPinButton, item.pinned && styles.memoryPinActive)}
                  title={item.pinned ? t('memoryUnpin') : t('memoryPin')}
                  onClick={() => void togglePin(item)}
                >
                  {item.pinned ? t('memoryPinned') : t('memoryPin')}
                </button>
                <div className={styles.memoryProposalBody}>
                  <span className={styles.memoryText}>{item.text}</span>
                  {item.description ? (
                    <span className={styles.memoryDescription}>{item.description}</span>
                  ) : null}
                </div>
                <div className={styles.memoryActions}>
                  <button
                    type="button"
                    className={styles.memoryIconButton}
                    title={t('memoryEdit')}
                    onClick={() =>
                      setEditor({
                        id: item.id,
                        text: item.text,
                        description: item.description ?? '',
                        pinned: item.pinned,
                      })
                    }
                  >
                    <IconEditOutline16 />
                  </button>
                  <button
                    type="button"
                    className={styles.memoryIconButton}
                    title={t('memoryDelete')}
                    onClick={() => void remove(item.id)}
                  >
                    <IconTrashOutline16 />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.memoryFooter}>
        <Button size="m" variant="outlined" onClick={() => importRef.current?.click()}>
          {t('memoryImport')}
        </Button>
        <input
          ref={importRef}
          type="file"
          accept=".txt,.md,.json,text/plain,application/json"
          hidden
          onChange={(event) => void importFile(event)}
        />
        <Button size="m" variant="outlined" onClick={() => void exportAll()}>
          {t('memoryExport')}
        </Button>
        <Button size="m" variant="dangerOutlined" onClick={() => void clear()}>
          {clearArmed ? t('memoryClearArmed') : t('memoryClear')}
        </Button>
      </div>

      {editor ? (
        <Modal
          title={editor.id === null ? t('memoryEditorAdd') : t('memoryEditorEdit')}
          className={styles.memoryEditor}
          onClose={() => setEditor(null)}
          footer={
            <div className={styles.memoryEditorActions}>
              <Button variant="outlined" onClick={() => setEditor(null)}>
                {t('memoryCancel')}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !editor.text.trim()}
                onClick={() => void saveEditor()}
              >
                {t('memorySave')}
              </Button>
            </div>
          }
        >
          <div className={styles.promptField}>
            <span className={styles.promptFieldLabel}>{t('memoryDescription')}</span>
            <input
              className={styles.promptInput}
              value={editor.description}
              maxLength={30}
              placeholder={t('memoryDescriptionPlaceholder')}
              onChange={(event) => setEditor({ ...editor, description: event.target.value })}
            />
          </div>
          <textarea
            className={styles.memoryTextarea}
            autoFocus
            rows={4}
            maxLength={limits.text}
            value={editor.text}
            placeholder={t('memoryAddPlaceholder')}
            onChange={(event) => setEditor({ ...editor, text: event.target.value })}
          />
          <div className={styles.memoryEditorMeta}>
            <label className={styles.memoryPinLabel}>
              <input
                type="checkbox"
                checked={editor.pinned}
                onChange={(event) => setEditor({ ...editor, pinned: event.target.checked })}
              />
              {t('memoryPin')}
            </label>
            <span>
              {editor.text.length} / {limits.text}
            </span>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

const Cell = ({
  label,
  description,
  action,
}: {
  label: string
  description?: string
  action: ReactNode
}) => (
  <div className={clsx(styles.cell, styles.row)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {description ? <div className={styles.description}>{description}</div> : null}
    </div>
    {action}
  </div>
)

const Switch = ({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: () => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={clsx(styles.switch, checked && styles.switchOn)}
    onClick={onChange}
  >
    <span className={styles.switchThumb} />
  </button>
)
