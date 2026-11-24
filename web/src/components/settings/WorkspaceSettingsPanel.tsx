import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { loadPrompts, type PromptCard } from '../../services/prompts.js'
import { useSettings } from '../../services/settings.js'
import {
  createWorkspace,
  deleteWorkspace,
  loadWorkspaces,
  renameWorkspace,
  setWorkspaceCard,
  useWorkspaceStore,
  type Workspace,
} from '../../services/workspaces.js'
import { Button } from '../base/Button.js'
import { IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'
import workspaceStyles from './WorkspaceSettingsPanel.module.css'

const MAX_NAME = 40
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const fail = (error: unknown) =>
  showToast({
    key: 'workspaceFailedWithReason',
    params: { message: messageOf(error) },
    type: 'error',
  })

type WorkspaceEditor = { id: string | null; name: string }

/** 设置 → 工作区：组织功能在本地和云端都可用，只有角色卡绑定限本地模式。 */
export const WorkspaceSettingsPanel = () => {
  const t = useTranslate()
  const local = useSettings((state) => state.mode === 'local')
  const items = useWorkspaceStore((state) => state.items)
  const loaded = useWorkspaceStore((state) => state.loaded)
  const loading = useWorkspaceStore((state) => state.loading)
  const workspaceError = useWorkspaceStore((state) => state.error)
  const [editor, setEditor] = useState<WorkspaceEditor | null>(null)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const [cards, setCards] = useState<PromptCard[] | null>(null)
  const [cardsLoading, setCardsLoading] = useState(false)
  const [cardsError, setCardsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const cardLoadSequence = useRef(0)

  useEffect(() => {
    void loadWorkspaces().catch(() => {})
  }, [])

  const loadCards = useCallback(async () => {
    const sequence = ++cardLoadSequence.current
    setCardsLoading(true)
    setCardsError(null)
    try {
      const state = await loadPrompts()
      if (sequence === cardLoadSequence.current) {
        setCards(state.cards)
      }
    } catch (error) {
      if (sequence === cardLoadSequence.current) {
        setCardsError(messageOf(error))
      }
    } finally {
      if (sequence === cardLoadSequence.current) {
        setCardsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!local) {
      return
    }
    void loadCards()
    return () => {
      cardLoadSequence.current += 1
    }
  }, [local, loadCards])

  const run = async (operation: () => Promise<void>) => {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(true)
    try {
      await operation()
    } catch (error) {
      fail(error)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const saveEditor = () => {
    const current = editor
    const name = current?.name.trim() ?? ''
    if (!current || !name || pending.current) {
      return
    }
    if (
      current.id !== null &&
      items.find((workspace) => workspace.id === current.id)?.name === name
    ) {
      setEditor(null)
      return
    }
    void run(async () => {
      if (current.id === null) {
        await createWorkspace(name)
        showToast({ key: 'workspaceCreated' })
      } else {
        await renameWorkspace(current.id, name)
        showToast({ key: 'workspaceRenamed' })
      }
      setEditor(null)
    })
  }

  const confirmDelete = () => {
    const current = deleting
    if (!current || pending.current) {
      return
    }
    void run(async () => {
      const result = await deleteWorkspace(current.id)
      setDeleting(null)
      showToast({ key: 'workspaceDeleted', params: { count: result.moved } })
    })
  }

  const bindCard = (workspace: Workspace, cardId: string | null) => {
    if (!local || pending.current || workspace.cardId === cardId) {
      return
    }
    void run(async () => {
      await setWorkspaceCard(workspace.id, cardId)
      showToast({ key: 'workspaceCardSaved' })
    })
  }

  const cardOptions = (workspace: Workspace) => {
    const options = [
      { value: '', label: t('workspaceGlobalCard') },
      ...(cards ?? []).map((card) => ({ value: card.id, label: card.name })),
    ]
    if (workspace.cardId && !cards?.some((card) => card.id === workspace.cardId)) {
      options.push({
        value: workspace.cardId,
        label: t(local ? 'workspaceCardUnavailable' : 'workspaceCardCloud'),
      })
    }
    return options
  }

  const cardsDisabled = !local || cards === null || cardsLoading || cardsError !== null

  return (
    <div className={styles.memoryPanel}>
      <div className={styles.memoryHint}>{t('workspaceSettingsHint')}</div>
      {!local ? <div className={styles.memoryNotice}>{t('promptCloudHint')}</div> : null}
      {workspaceError ? (
        <div className={workspaceStyles.errorRow} role="alert">
          <span>{workspaceError}</span>
          <Button
            size="s"
            variant="outlined"
            disabled={loading || busy}
            onClick={() => void loadWorkspaces(true).catch(() => {})}
          >
            {t('retry')}
          </Button>
        </div>
      ) : null}
      <div className={styles.memorySection}>
        <div className={styles.memorySectionHeader}>
          <div className={styles.memorySectionTitle}>
            {t('workspaces')}
            <span className={styles.memoryCount}>{items.length}</span>
          </div>
          <Button
            size="s"
            variant="outlined"
            disabled={!loaded || busy}
            onClick={() => setEditor({ id: null, name: '' })}
          >
            {t('workspaceCreate')}
          </Button>
        </div>
        {!loaded ? (
          <div className={styles.memoryNotice} role="status">
            {t(loading ? 'workspaceLoading' : 'workspaceLoadFailed')}
          </div>
        ) : items.length === 0 ? (
          <div className={styles.memoryHint}>{t('workspaceSettingsEmpty')}</div>
        ) : (
          <div className={styles.memoryList}>
            {items.map((workspace) => (
              <div key={workspace.id} className={workspaceStyles.item}>
                <div className={workspaceStyles.header}>
                  <div className={workspaceStyles.name} title={workspace.name}>
                    {workspace.name}
                  </div>
                  <div className={styles.memoryActions}>
                    <button
                      type="button"
                      className={styles.memoryIconButton}
                      disabled={busy}
                      title={t('workspaceRename')}
                      aria-label={t('workspaceRename')}
                      onClick={() => setEditor({ id: workspace.id, name: workspace.name })}
                    >
                      <IconEditOutline16 />
                    </button>
                    <button
                      type="button"
                      className={styles.memoryIconButton}
                      disabled={busy}
                      title={t('workspaceDelete')}
                      aria-label={t('workspaceDelete')}
                      onClick={() => setDeleting(workspace)}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </div>
                </div>
                <div className={workspaceStyles.binding}>
                  <span className={workspaceStyles.bindingLabel}>{t('workspaceCard')}</span>
                  <Select
                    ariaLabel={t('workspaceCardFor', { name: workspace.name })}
                    value={workspace.cardId ?? ''}
                    options={cardOptions(workspace)}
                    disabled={busy || cardsDisabled}
                    onChange={(value) => bindCard(workspace, value || null)}
                  />
                </div>
                {local && cardsLoading ? (
                  <div className={styles.memoryHint}>{t('workspaceCardsLoading')}</div>
                ) : null}
                {local && cardsError ? (
                  <div className={workspaceStyles.cardError} role="alert">
                    <span>{t('workspaceCardsFailed', { message: cardsError })}</span>
                    <button type="button" onClick={() => void loadCards()}>
                      {t('retry')}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {editor ? (
        <Modal
          title={t(editor.id === null ? 'workspaceCreate' : 'workspaceRename')}
          className={styles.memoryEditor}
          onClose={() => {
            if (!pending.current) {
              setEditor(null)
            }
          }}
          footer={
            <div className={styles.memoryEditorActions} aria-busy={busy}>
              <Button variant="outlined" disabled={busy} onClick={() => setEditor(null)}>
                {t('memoryCancel')}
              </Button>
              <Button
                disabled={
                  busy ||
                  !editor.name.trim() ||
                  (editor.id !== null &&
                    items.find((workspace) => workspace.id === editor.id)?.name ===
                      editor.name.trim())
                }
                onClick={saveEditor}
              >
                {t('memorySave')}
              </Button>
            </div>
          }
        >
          <label className={styles.promptField}>
            <span className={styles.promptFieldLabel}>{t('workspaceName')}</span>
            <input
              className={styles.promptInput}
              value={editor.name}
              maxLength={MAX_NAME}
              autoFocus
              disabled={busy}
              placeholder={t('workspaceNamePlaceholder')}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  saveEditor()
                }
              }}
            />
          </label>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title={t('workspaceDelete')}
          className={styles.deleteConfirm}
          onClose={() => {
            if (!pending.current) {
              setDeleting(null)
            }
          }}
          footer={
            <div className={styles.deleteActions} aria-busy={busy}>
              <Button variant="outlined" disabled={busy} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={confirmDelete}>
                {t('delete')}
              </Button>
            </div>
          }
        >
          {t('workspaceDeleteDescription', { name: deleting.name })}
        </Modal>
      ) : null}
    </div>
  )
}
