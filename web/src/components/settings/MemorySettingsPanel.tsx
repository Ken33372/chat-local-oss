import clsx from 'clsx'
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
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
  const [editor, setEditor] = useState<{ id: number | null; text: string; pinned: boolean } | null>(
    null
  )
  const [limits, setLimits] = useState({ text: 100, items: 200 })
  const [busy, setBusy] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
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
        const item = await addMemory(editor.text.trim(), editor.pinned)
        setItems((current) => [item, ...current])
        showToast({ key: 'memoryAdded' })
      } else {
        const updated = await updateMemory(editor.id, editor.text.trim(), editor.pinned)
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
      {enabled ? (
        <>
          <Cell
            label={t('memoryInject')}
            description={t('memoryInjectDescription')}
            action={
              <Select
                ariaLabel={t('memoryInject')}
                value={settings.inject}
                options={[
                  { value: 'recent', label: t('memoryInjectRecent') },
                  { value: 'off', label: t('memoryInjectOff') },
                ]}
                onChange={(value) => void patch({ inject: value as MemorySettings['inject'] })}
              />
            }
          />
          {settings.inject !== 'off' ? (
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
        </>
      ) : null}

      <div className={styles.memorySection}>
        <div className={styles.memorySectionTitle}>
          {t('memoryPending')}
          {proposals.length ? ` · ${proposals.length}` : ''}
        </div>
        {proposals.length === 0 ? (
          <div className={styles.memoryHint}>{t('memoryPendingEmpty')}</div>
        ) : (
          <div className={styles.memoryList}>
            {proposals.map((proposal) => (
              <div key={proposal.id} className={clsx(styles.memoryRow, styles.memoryRowPending)}>
                <span className={styles.memoryText}>{proposal.text}</span>
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
        )}
      </div>

      <div className={styles.memorySection}>
        <div className={styles.memorySectionHeader}>
          <div className={styles.memorySectionTitle}>
            {t('memoryItems')}
            <span className={styles.memoryCount}>
              {items.length} / {limits.items}
            </span>
          </div>
          <Button
            size="s"
            variant="outlined"
            disabled={items.length >= limits.items}
            onClick={() => setEditor({ id: null, text: '', pinned: false })}
          >
            {t('memoryAdd')}
          </Button>
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
                <span className={styles.memoryText}>{item.text}</span>
                <div className={styles.memoryActions}>
                  <button
                    type="button"
                    className={styles.memoryIconButton}
                    title={t('memoryEdit')}
                    onClick={() => setEditor({ id: item.id, text: item.text, pinned: item.pinned })}
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
