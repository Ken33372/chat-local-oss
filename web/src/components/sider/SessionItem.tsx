import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { useWorkspaceStore } from '../../services/workspaces.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onMove,
  onDelete,
  onArchive,
}: {
  session: SessionSummary
  active: boolean
  onMove: (sessionId: string, workspaceId: string | null) => void
  onDelete: (session: SessionSummary) => void
  onArchive: (sessionId: string) => void
}) {
  const t = useTranslate()
  const workspaces = useWorkspaceStore((state) => state.items)
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveTarget, setMoveTarget] = useState<string | null>(session.workspaceId ?? null)
  const displayTitle = session.title || t('untitledChat')
  const destinations: { id: string | null; label: string }[] = [
    { id: null, label: t('workspaceUngrouped') },
    ...workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name })),
  ].filter((destination) => destination.id !== (session.workspaceId ?? null))
  const openMove = () => {
    setMoveTarget(destinations[0]?.id ?? null)
    setMoveOpen(true)
  }
  const confirmMove = () => {
    setMoveOpen(false)
    if (moveTarget !== (session.workspaceId ?? null)) {
      onMove(session.id, moveTarget)
    }
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <>
      <div
        className={clsx(styles.item, active && styles.active, menuOpen && styles.menuOpen)}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
        <div className={styles.title}>{displayTitle}</div>
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            onOpenChange={setMenuOpen}
            options={[
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              ...(destinations.length > 0
                ? [
                    {
                      key: 'move',
                      label: t('workspaceMove'),
                      icon: <IconFolderOutline16 />,
                      onSelect: openMove,
                    },
                  ]
                : []),
              {
                key: 'archive',
                label: t('archiveSession'),
                icon: <IconDownloadOutline16 />,
                onSelect: () => onArchive(session.id),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: () => onDelete(session),
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
            )}
          </Menu>
        </div>
      </div>
      {moveOpen ? (
        <Modal
          title={t('workspaceMoveTitle')}
          onClose={() => setMoveOpen(false)}
          footer={
            <div className={styles.moveActions}>
              <Button variant="outlined" onClick={() => setMoveOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={moveTarget === (session.workspaceId ?? null)}
                onClick={confirmMove}
              >
                {t('workspaceMoveConfirm')}
              </Button>
            </div>
          }
        >
          <label className={styles.moveField}>
            <span className={styles.moveLabel}>{t('workspaceMoveHint')}</span>
            <Select
              ariaLabel={t('workspaceMoveTitle')}
              value={moveTarget ?? ''}
              options={destinations.map((destination) => ({
                value: destination.id ?? '',
                label: destination.label,
              }))}
              onChange={(value) => setMoveTarget(value || null)}
            />
          </label>
        </Modal>
      ) : null}
    </>
  )
})
