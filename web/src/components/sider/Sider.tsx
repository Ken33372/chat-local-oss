import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconAddOutline16,
  IconCloseOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { searchSessions, type SessionSearchResult } from '../../services/chat/db.js'
import {
  newChat,
  removeSession,
  selectSession,
  setSessionArchived,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import {
  createWorkspace,
  deleteWorkspace,
  loadWorkspaces,
  moveSession,
  renameWorkspace,
  selectWorkspace,
  UNASSIGNED_WORKSPACE_ID,
  useWorkspaceStore,
  type Workspace,
} from '../../services/workspaces.js'
import { formatDate } from '../../utils/format.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useDebugPanel } from '../debug/debugPanelState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

const MAX_WORKSPACE_NAME = 40

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const workspaces = useWorkspaceStore((state) => state.items)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedId)
  const workspacesLoading = useWorkspaceStore((state) => state.loading)
  const workspacesLoaded = useWorkspaceStore((state) => state.loaded)
  const workspaceError = useWorkspaceStore((state) => state.error)
  const [workspaceEditor, setWorkspaceEditor] = useState<{ id: string | null; name: string } | null>(
    null
  )
  const [workspaceDeleting, setWorkspaceDeleting] = useState<Workspace | null>(null)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const workspaceBusyRef = useRef(false)
  const [now, setNow] = useState(Date.now)
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !session.archived &&
          (selectedWorkspaceId === null ||
            (selectedWorkspaceId === UNASSIGNED_WORKSPACE_ID
              ? (session.workspaceId ?? null) === null
              : (session.workspaceId ?? null) === selectedWorkspaceId))
      ),
    [sessions, selectedWorkspaceId]
  )
  const groups = useMemo(() => groupSessions(visibleSessions, now, t), [visibleSessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const nameTaps = useRef<number[]>([])
  const handleMove = useCallback((sessionId: string, workspaceId: string | null) => {
    void moveSession(sessionId, workspaceId).catch((error: unknown) => {
      showToast({
        key: 'workspaceFailedWithReason',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    })
  }, [])
  const handleDelete = useCallback((target: SessionSummary) => setDeleting(target), [])
  const handleArchive = useCallback(async (sessionId: string) => {
    if (!(await setSessionArchived(sessionId, true))) {
      showToast({ key: 'archiveFailed', type: 'error' })
    }
  }, [])
  const runWorkspaceAction = async (operation: () => Promise<void>) => {
    if (workspaceBusyRef.current) {
      return
    }
    workspaceBusyRef.current = true
    setWorkspaceBusy(true)
    try {
      await operation()
    } catch (error) {
      showToast({
        key: 'workspaceFailedWithReason',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      workspaceBusyRef.current = false
      setWorkspaceBusy(false)
    }
  }
  const saveWorkspaceEditor = () => {
    const current = workspaceEditor
    const name = current?.name.trim() ?? ''
    if (!current || !name || workspaceBusyRef.current) {
      return
    }
    if (
      current.id !== null &&
      workspaces.find((workspace) => workspace.id === current.id)?.name === name
    ) {
      setWorkspaceEditor(null)
      return
    }
    void runWorkspaceAction(async () => {
      if (current.id === null) {
        await createWorkspace(name)
        showToast({ key: 'workspaceCreated' })
      } else {
        await renameWorkspace(current.id, name)
        showToast({ key: 'workspaceRenamed' })
      }
      setWorkspaceEditor(null)
    })
  }
  const confirmWorkspaceDelete = () => {
    const current = workspaceDeleting
    if (!current || workspaceBusyRef.current) {
      return
    }
    void runWorkspaceAction(async () => {
      const result = await deleteWorkspace(current.id)
      setWorkspaceDeleting(null)
      showToast({ key: 'workspaceDeleted', params: { count: result.moved } })
    })
  }
  const chooseWorkspace = (id: string | null) => {
    selectWorkspace(id)
    closeMobileSider()
  }

  // 隐藏入口：1.5 秒内连点标题 5 次打开调试面板
  const onNameClick = () => {
    const now = Date.now()
    nameTaps.current = [...nameTaps.current.filter((at) => now - at < 1500), now]
    if (nameTaps.current.length >= 5) {
      nameTaps.current = []
      useDebugPanel.getState().openPanel()
    }
  }

  useEffect(() => {
    if (searchOpen) {
      searchRef.current?.focus()
    }
  }, [searchOpen])

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResults([])
      setSearching(false)
      setSearchFailed(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    setSearchFailed(false)
    const timer = setTimeout(() => {
      void searchSessions(text, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) {
            setResults(next)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([])
            setSearchFailed(true)
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearching(false)
          }
        })
    }, 220)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    setResults([])
    setSearching(false)
    setSearchFailed(false)
  }

  const openResult = (id: string) => {
    selectSession(id)
    closeSearch()
    closeMobileSider()
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName} onClick={onNameClick}>
          {t('appName')}
        </div>
        <div className={styles.topActions}>
          <IconButton
            size="m"
            icon={<IconSearchOutline16 />}
            tooltip={t('sessionSearch')}
            tooltipPlacement="bottom"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          />
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
          />
        </div>
      </div>
      {searchOpen ? (
        <label className={styles.searchRow}>
          <span className={styles.searchIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            ref={searchRef}
            className={styles.searchInput}
            value={query}
            placeholder={t('sessionSearchPlaceholder')}
            aria-label={t('sessionSearchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeSearch()
              } else if (
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                results[0]
              ) {
                event.preventDefault()
                openResult(results[0].id)
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className={styles.searchClear}
              aria-label={t('sessionSearchClear')}
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <IconCloseOutline16 />
            </button>
          ) : null}
        </label>
      ) : null}
      <div className={styles.workspaceNav}>
        <div className={styles.workspaceHeader}>
          <span className={styles.workspaceHeaderTitle}>{t('workspaces')}</span>
          <div className={styles.workspaceHeaderActions}>
            <button
              type="button"
              className={clsx(
                styles.workspaceAll,
                selectedWorkspaceId === null && styles.workspaceAllActive
              )}
              aria-pressed={selectedWorkspaceId === null}
              onClick={() => chooseWorkspace(null)}
            >
              {t('workspaceAll')}
            </button>
            <IconButton
              icon={<IconAddOutline16 />}
              tooltip={t('workspaceCreate')}
              disabled={!workspacesLoaded || workspaceBusy}
              onClick={() => setWorkspaceEditor({ id: null, name: '' })}
            />
          </div>
        </div>
        <div className={styles.workspaceList} aria-label={t('workspaces')}>
          <div
            className={clsx(
              styles.workspaceRow,
              selectedWorkspaceId === UNASSIGNED_WORKSPACE_ID && styles.workspaceRowActive
            )}
          >
            <button
              type="button"
              className={styles.workspaceSelect}
              aria-pressed={selectedWorkspaceId === UNASSIGNED_WORKSPACE_ID}
              onClick={() => chooseWorkspace(UNASSIGNED_WORKSPACE_ID)}
            >
              <span className={styles.workspaceIcon}>
                <IconFolderOutline16 />
              </span>
              <span className={styles.workspaceName}>{t('workspaceUngrouped')}</span>
            </button>
            {selectedWorkspaceId === UNASSIGNED_WORKSPACE_ID ? (
              <div className={styles.workspaceActions}>
                <IconButton
                  className={styles.workspaceAdd}
                  icon={<IconAddOutline16 />}
                  tooltip={t('newChatInWorkspace', { name: t('workspaceUngrouped') })}
                  onClick={() => {
                    newChat(null)
                    closeMobileSider()
                  }}
                />
              </div>
            ) : null}
          </div>
          {workspaces.map((workspace) => {
            const active = workspace.id === selectedWorkspaceId
            return (
              <div
                key={workspace.id}
                className={clsx(styles.workspaceRow, active && styles.workspaceRowActive)}
              >
                <button
                  type="button"
                  className={styles.workspaceSelect}
                  aria-pressed={active}
                  onClick={() => chooseWorkspace(workspace.id)}
                >
                  <span className={styles.workspaceIcon}>
                    <IconFolderOutline16 />
                  </span>
                  <span className={styles.workspaceName} title={workspace.name}>
                    {workspace.name}
                  </span>
                </button>
                <div className={styles.workspaceActions} onClick={(event) => event.stopPropagation()}>
                  <Menu
                    options={[
                      {
                        key: 'rename',
                        label: t('workspaceRename'),
                        icon: <IconEditOutline16 />,
                        onSelect: () => setWorkspaceEditor({ id: workspace.id, name: workspace.name }),
                      },
                      {
                        key: 'card',
                        label: t('workspaceCardSettings'),
                        icon: <IconSettingsOutline16 />,
                        onSelect: () => openSettings('workspaces'),
                      },
                      {
                        key: 'delete',
                        label: t('workspaceDelete'),
                        icon: <IconTrashOutline16 />,
                        danger: true,
                        onSelect: () => setWorkspaceDeleting(workspace),
                      },
                    ]}
                  >
                    {({ toggle }) => (
                      <IconButton
                        icon={<IconEllipsisOutline16 />}
                        tooltip={t('more')}
                        aria-label={t('more')}
                        disabled={workspaceBusy}
                        onClick={toggle}
                      />
                    )}
                  </Menu>
                  {active ? (
                    <IconButton
                      className={styles.workspaceAdd}
                      icon={<IconAddOutline16 />}
                      tooltip={t('newChatInWorkspace', { name: workspace.name })}
                      onClick={() => {
                        newChat(workspace.id)
                        closeMobileSider()
                      }}
                    />
                  ) : null}
                </div>
              </div>
            )
          })}
          {workspacesLoaded && workspaces.length === 0 ? (
            <div className={styles.workspaceEmpty}>{t('workspaceSettingsEmpty')}</div>
          ) : null}
        </div>
      </div>
      {workspaceError ? (
        <div className={clsx(styles.workspaceNotice, styles.workspaceError)} role="alert">
          <span title={workspaceError}>{t('workspaceLoadFailed')}</span>
          <button type="button" onClick={() => void loadWorkspaces(true).catch(() => {})}>
            {t('retry')}
          </button>
        </div>
      ) : workspacesLoading && !workspacesLoaded ? (
        <div className={styles.workspaceNotice} role="status">
          {t('workspaceLoading')}
        </div>
      ) : null}
      <div className={styles.listWrap}>
        {query.trim() ? (
          <div className={styles.searchResults}>
            {searching ? (
              <div className={styles.searchEmpty}>{t('sessionSearching')}</div>
            ) : searchFailed ? (
              <div className={styles.searchEmpty}>{t('sessionSearchFailed')}</div>
            ) : results.length === 0 ? (
              <div className={styles.searchEmpty}>{t('sessionSearchEmpty')}</div>
            ) : (
              results.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  className={styles.searchResult}
                  onClick={() => openResult(result.id)}
                >
                  <span className={styles.searchResultTop}>
                    <span className={styles.searchResultTitle}>
                      {result.title || t('untitledChat')}
                    </span>
                    <span className={styles.searchResultDate}>
                      {formatDate(result.updatedAt, '/') ?? ''}
                    </span>
                  </span>
                  {result.matches.slice(0, 2).map((match, index) => (
                    <span
                      key={`${match.messageId || 'title'}-${index}`}
                      className={styles.searchSnippet}
                    >
                      <span className={styles.searchSnippetRole}>
                        {match.role === 'user'
                          ? t('sessionSearchYou')
                          : match.role === 'assistant'
                            ? t('sessionSearchAssistant')
                            : t('sessionSearchTitle')}
                      </span>
                      {match.snippet}
                    </span>
                  ))}
                  {result.matchCount > 2 ? (
                    <span className={styles.searchMore}>
                      {t('sessionSearchMore', { count: result.matchCount - 2 })}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        ) : (
          <div className={styles.list}>
            {groups.length === 0 && selectedWorkspaceId !== null ? (
              <div className={styles.searchEmpty}>{t('workspaceEmpty')}</div>
            ) : null}
            {groups.map((group) => (
              <div key={group.key} className={styles.section}>
                <div className={styles.sectionHeader}>{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    onMove={handleMove}
                    onDelete={handleDelete}
                    onArchive={handleArchive}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {workspaceEditor ? (
        <Modal
          title={t(workspaceEditor.id === null ? 'workspaceCreate' : 'workspaceRename')}
          onClose={() => {
            if (!workspaceBusyRef.current) {
              setWorkspaceEditor(null)
            }
          }}
          footer={
            <div className={styles.workspaceEditorActions}>
              <Button
                variant="outlined"
                disabled={workspaceBusy}
                onClick={() => setWorkspaceEditor(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={
                  workspaceBusy ||
                  !workspaceEditor.name.trim() ||
                  (workspaceEditor.id !== null &&
                    workspaces.find((workspace) => workspace.id === workspaceEditor.id)?.name ===
                      workspaceEditor.name.trim())
                }
                onClick={saveWorkspaceEditor}
              >
                {t('memorySave')}
              </Button>
            </div>
          }
        >
          <label className={styles.workspaceEditorField}>
            <span className={styles.workspaceEditorLabel}>{t('workspaceName')}</span>
            <input
              className={styles.workspaceEditorInput}
              value={workspaceEditor.name}
              maxLength={MAX_WORKSPACE_NAME}
              autoFocus
              disabled={workspaceBusy}
              placeholder={t('workspaceNamePlaceholder')}
              onChange={(event) =>
                setWorkspaceEditor({ ...workspaceEditor, name: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  saveWorkspaceEditor()
                }
              }}
            />
          </label>
        </Modal>
      ) : null}

      {workspaceDeleting ? (
        <Modal
          title={t('workspaceDelete')}
          onClose={() => {
            if (!workspaceBusyRef.current) {
              setWorkspaceDeleting(null)
            }
          }}
          footer={
            <div className={styles.workspaceEditorActions}>
              <Button
                variant="outlined"
                disabled={workspaceBusy}
                onClick={() => setWorkspaceDeleting(null)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={workspaceBusy} onClick={confirmWorkspaceDelete}>
                {t('delete')}
              </Button>
            </div>
          }
        >
          {t('workspaceDeleteDescription', { name: workspaceDeleting.name })}
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
