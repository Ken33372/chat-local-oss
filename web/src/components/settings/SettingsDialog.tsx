import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ImportMode,
} from '../../services/chat/backup.js'
import {
  cleanSessionContent,
  deleteSessionsByTime,
  previewMaintenance,
  type MaintenancePreview,
} from '../../services/chat/db.js'
import {
  refreshAfterMaintenance,
  removeSession,
  selectSession,
  setSessionArchived,
  stopAllReplies,
  useChatStore,
} from '../../services/chat/store.js'
import { formatDate } from '../../utils/format.js'
import { useSetupWizard } from '../../services/setup.js'
import { useIsMobile } from '../../app/viewport.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setAutoTitle,
  setLocation,
  setMaxToolRounds,
  setMode,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ChatMode,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const mode = useSettings((state) => state.mode)
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const openSetupWizard = useSetupWizard((state) => state.openWizard)
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ModeSetting />
              {mode === 'local' ? (
                <SettingCell
                  label={t('setupSettingsLabel')}
                  description={t('setupSettingsDesc')}
                  status={null}
                  action={
                    <Button
                      variant="outlined"
                      size="m"
                      className={styles.cellButton}
                      onClick={openSetupWizard}
                    >
                      {t('setupSettingsAction')}
                    </Button>
                  }
                />
              ) : null}
              {mode === 'local' ? <MaxToolRoundsSetting /> : null}
              {mode === 'local' ? <AutoTitleSetting /> : null}
              <ThemeSetting />
              <LocaleSetting />
              {mode === 'cloud' ? <TtsVoiceSetting /> : null}
              <LocationSetting />
            </>
          ) : (
            <>
              {mode === 'cloud' ? <ApiKeyField editor={apiKeyEditor} /> : null}
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('archivedChats')}
                description={t('archivedChatsDesc')}
                status={null}
                action={
                  <Button
                    variant="outlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={() => setArchiveOpen(true)}
                  >
                    {t('openArchive')}
                  </Button>
                }
              />
              <SettingCell
                label={t('cleanupChats')}
                description={t('cleanupChatsDesc')}
                status={null}
                action={
                  <Button
                    variant="outlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={() => setCleanupOpen(true)}
                  >
                    {t('openCleanup')}
                  </Button>
                }
              />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile && mode === 'cloud' ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      {archiveOpen ? <ArchiveDialog onClose={() => setArchiveOpen(false)} /> : null}
      {cleanupOpen ? <CleanupDialog onClose={() => setCleanupOpen(false)} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

/** 归档列表：点标题打开会话，右侧支持恢复或永久删除。 */
const ArchiveDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions).filter((session) => session.archived)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const deleting = sessions.find((session) => session.id === deletingId) ?? null

  const restore = async (id: string) => {
    setBusyId(id)
    const ok = await setSessionArchived(id, false)
    setBusyId(null)
    if (ok) {
      showToast({ key: 'archivedRestored' })
    } else {
      showToast({ key: 'restoreFailed', type: 'error' })
    }
  }

  const confirmDelete = async () => {
    if (!deletingId) {
      return
    }
    setDeletePending(true)
    try {
      if (await removeSession(deletingId)) {
        setDeletingId(null)
      } else {
        showToast({ key: 'sessionDeleteFailed', type: 'error' })
      }
    } finally {
      setDeletePending(false)
    }
  }

  return (
    <>
      <Modal
        title={t('archivedChats')}
        className={styles.archiveDialog}
        closable
        onClose={onClose}
      >
        <div className={styles.archiveHint}>{t('archivedChatsDesc')}</div>
        {sessions.length === 0 ? (
          <div className={styles.archiveEmpty}>{t('archiveEmpty')}</div>
        ) : (
          <div className={styles.archiveList}>
            {sessions.map((session) => (
              <div key={session.id} className={styles.archiveRow}>
                <button
                  type="button"
                  className={styles.archiveOpen}
                  onClick={() => {
                    selectSession(session.id)
                    closeSettings()
                    onClose()
                  }}
                >
                  <span className={styles.archiveTitle}>{session.title || t('untitledChat')}</span>
                  <span className={styles.archiveDate}>
                    {formatDate(session.updatedAt, '/') ?? ''}
                  </span>
                </button>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={busyId !== null || deletePending}
                  onClick={() => void restore(session.id)}
                >
                  {t('restoreChat')}
                </Button>
                <Button
                  variant="dangerOutlined"
                  size="m"
                  disabled={busyId !== null || deletePending}
                  onClick={() => setDeletingId(session.id)}
                >
                  {t('delete')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeletingId(null)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={deletePending}
                onClick={() => setDeletingId(null)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={deletePending} onClick={() => void confirmDelete()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </>
  )
}

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${bytes} B`
}

/** 清理：按时间删除，或只移除工具调用记录与图片；操作前后都重新拉取统计和列表。 */
const CleanupDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [mode, setMode] = useState<'older' | 'range'>('older')
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState<'years' | 'months'>('years')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [tools, setTools] = useState(true)
  const [images, setImages] = useState(true)
  const [preview, setPreview] = useState<MaintenancePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [previewError, setPreviewError] = useState(false)
  const [busy, setBusy] = useState<'delete' | 'clean' | null>(null)

  const timeFilter = useMemo((): Record<string, number> => {
    if (mode === 'older') {
      const value = Number(amount)
      if (!Number.isFinite(value) || value <= 0) {
        return {}
      }
      const cutoff = new Date()
      const count = Math.max(1, Math.floor(value))
      if (unit === 'years') {
        cutoff.setFullYear(cutoff.getFullYear() - count)
      } else {
        cutoff.setMonth(cutoff.getMonth() - count)
      }
      return { olderThan: cutoff.getTime() }
    }
    if (!from || !to) {
      return {}
    }
    const start = new Date(`${from}T00:00:00`).getTime()
    const end = new Date(`${to}T23:59:59.999`).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      return {}
    }
    return { from: start, to: end }
  }, [mode, amount, unit, from, to])

  const refreshPreview = async () => {
    const next = await previewMaintenance({ ...timeFilter, toolRecords: tools, images })
    setPreview(next)
  }

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setPreviewError(false)
      try {
        const next = await previewMaintenance({ ...timeFilter, toolRecords: tools, images })
        if (!cancelled) {
          setPreview(next)
        }
      } catch {
        if (!cancelled) {
          setPreview(null)
          setPreviewError(true)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [timeFilter, tools, images])

  const removeByTime = async () => {
    if (!preview || preview.delete.sessions === 0) {
      return
    }
    setBusy('delete')
    try {
      await stopAllReplies()
      const result = await deleteSessionsByTime(timeFilter)
      await refreshAfterMaintenance()
      await refreshPreview().catch(() => {})
      showToast({ key: 'cleanupDeleteDone', params: { count: result.sessions } })
    } catch {
      showToast({ key: 'cleanupFailed', type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const cleanContent = async () => {
    if (!tools && !images) {
      return
    }
    setBusy('clean')
    try {
      await stopAllReplies()
      const result = await cleanSessionContent({ toolRecords: tools, images })
      await refreshAfterMaintenance()
      await refreshPreview().catch(() => {})
      showToast({ key: 'cleanupContentDone', params: { sessions: result.sessions } })
    } catch {
      showToast({ key: 'cleanupFailed', type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const deleteCount = preview?.delete.sessions ?? 0
  const cleanStats = preview?.clean
  const cleanEmpty =
    !cleanStats ||
    ((!tools || cleanStats.toolBlocks === 0) && (!images || cleanStats.images === 0))
  const disabled = busy !== null
  const actionsDisabled = disabled || loading

  return (
    <Modal title={t('cleanupChats')} className={styles.cleanupDialog} onClose={onClose}>
      <div className={styles.cleanupSection}>
        <div className={styles.cleanupSectionTitle}>{t('cleanupChats')}</div>
        <div className={styles.cleanupModes} role="radiogroup" aria-label={t('cleanupChats')}>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'older'}
            disabled={disabled}
            className={clsx(styles.importMode, mode === 'older' && styles.importModeActive)}
            onClick={() => setMode('older')}
          >
            <span className={styles.importModeTitle}>{t('cleanupOlderMode')}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'range'}
            disabled={disabled}
            className={clsx(styles.importMode, mode === 'range' && styles.importModeActive)}
            onClick={() => setMode('range')}
          >
            <span className={styles.importModeTitle}>{t('cleanupCustomMode')}</span>
          </button>
        </div>
        {mode === 'older' ? (
          <div className={styles.cleanupRow}>
            <input
              className={styles.cleanupNumber}
              type="number"
              min={1}
              max={99}
              value={amount}
              disabled={disabled}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Select
              className={styles.cleanupSelect}
              ariaLabel={t('cleanupYears')}
              value={unit}
              disabled={disabled}
              options={[
                { value: 'years' as const, label: t('cleanupYears') },
                { value: 'months' as const, label: t('cleanupMonths') },
              ]}
              onChange={(value) => setUnit(value === 'months' ? 'months' : 'years')}
            />
          </div>
        ) : (
          <div className={styles.cleanupRow}>
            <input
              className={styles.cleanupDate}
              type="date"
              value={from}
              disabled={disabled}
              onChange={(event) => setFrom(event.target.value)}
            />
            <span>—</span>
            <input
              className={styles.cleanupDate}
              type="date"
              value={to}
              disabled={disabled}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        )}
        <div className={styles.cleanupPreviewText}>
          {previewError
            ? t('cleanupPreviewFailed')
            : loading
              ? t('cleanupLoading')
              : deleteCount > 0
                ? t('cleanupDeletePreview', {
                    count: deleteCount,
                    size: formatSize(preview?.delete.bytes ?? 0),
                  })
                : t('cleanupDeleteNone')}
        </div>
        <div className={styles.cleanupActions}>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={actionsDisabled || deleteCount === 0}
            onClick={() => void removeByTime()}
          >
            {busy === 'delete' ? t('cleanupBusy') : t('cleanupDeleteAction', { count: deleteCount })}
          </Button>
        </div>
      </div>

      <div className={styles.cleanupSection}>
        <div className={styles.cleanupSectionTitle}>{t('cleanupContentTitle')}</div>
        <label className={styles.importOption}>
          <input
            type="checkbox"
            checked={tools}
            disabled={disabled}
            onChange={(event) => setTools(event.target.checked)}
          />
          <span className={styles.importOptionText}>
            <span className={styles.importOptionTitle}>{t('cleanupToolsOption')}</span>
          </span>
        </label>
        <label className={styles.importOption}>
          <input
            type="checkbox"
            checked={images}
            disabled={disabled}
            onChange={(event) => setImages(event.target.checked)}
          />
          <span className={styles.importOptionText}>
            <span className={styles.importOptionTitle}>{t('cleanupImagesOption')}</span>
          </span>
        </label>
        <div className={styles.cleanupPreviewText}>
          {loading
            ? t('cleanupLoading')
            : cleanEmpty
              ? t('cleanupContentNone')
              : t('cleanupContentPreview', {
                  sessions: cleanStats?.sessions ?? 0,
                  tools: cleanStats?.toolBlocks ?? 0,
                  images: cleanStats?.images ?? 0,
                  size: formatSize(cleanStats?.bytes ?? 0),
                })}
        </div>
        {tools && !cleanEmpty ? (
          <div className={styles.cleanupWarning}>{t('cleanupCacheWarning')}</div>
        ) : null}
        <div className={styles.cleanupActions}>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={actionsDisabled || cleanEmpty}
            onClick={() => void cleanContent()}
          >
            {busy === 'clean' ? t('cleanupBusy') : t('cleanupContentAction')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

/** 模型来源：DeepSeek 云端 / 自建后端；自建后端顺带显示模型接口状态 */
const ModeSetting = () => {
  const t = useTranslate()
  const mode = useSettings((state) => state.mode)
  const [status, setStatus] = useState<'checking' | 'online' | 'model-offline' | 'offline'>(
    'checking'
  )

  useEffect(() => {
    if (mode !== 'local') {
      return
    }
    let cancelled = false
    setStatus('checking')
    fetch('/api/health')
      .then((response) => response.json())
      .then((body: { llm?: { ok?: boolean } }) => {
        if (!cancelled) {
          setStatus(body.llm?.ok ? 'online' : 'model-offline')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('offline')
        }
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  const statusKey =
    status === 'online'
      ? 'settingsModeStatusOnline'
      : status === 'model-offline'
        ? 'settingsModeStatusModelOffline'
        : status === 'offline'
          ? 'settingsModeStatusOffline'
          : 'settingsModeStatusChecking'

  return (
    <SettingCell
      label={t('settingsMode')}
      description={t(
        mode === 'local' ? 'settingsModeLocalDescription' : 'settingsModeCloudDescription'
      )}
      status={mode === 'local' ? { key: statusKey } : null}
      action={
        <Select
          ariaLabel={t('settingsMode')}
          value={mode}
          options={[
            { value: 'local', label: t('settingsModeLocal') },
            { value: 'cloud', label: t('settingsModeCloud') },
          ]}
          onChange={(value) => setMode(value as ChatMode)}
        />
      }
    />
  )
}

/** 本地模式：一次回答里最多允许多少轮工具调用 */
const MaxToolRoundsSetting = () => {
  const t = useTranslate()
  const maxToolRounds = useSettings((state) => state.maxToolRounds)
  const values = [3, 5, 8, 12, 20]
  if (!values.includes(maxToolRounds)) {
    values.push(maxToolRounds)
    values.sort((a, b) => a - b)
  }
  return (
    <SettingCell
      label={t('settingsMaxToolRounds')}
      description={t('settingsMaxToolRoundsDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsMaxToolRounds')}
          value={String(maxToolRounds)}
          options={values.map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => setMaxToolRounds(Number(value))}
        />
      }
    />
  )
}

/** 本地模式：首轮回复完成后是否额外请求一次模型生成标题。 */
const AutoTitleSetting = () => {
  const t = useTranslate()
  const autoTitle = useSettings((state) => state.autoTitle)
  return (
    <SettingCell
      label={t('settingsAutoTitle')}
      description={t('settingsAutoTitleDescription')}
      status={null}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={autoTitle}
          aria-label={t('settingsAutoTitle')}
          className={clsx(styles.switch, autoTitle && styles.switchOn)}
          onClick={() => setAutoTitle(!autoTitle)}
        >
          <span className={styles.switchThumb} />
        </button>
      }
    />
  )
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 三种导入方式：覆盖、合并跳过重复、合并冲突另存副本 */
const importModes: { value: ImportMode; label: TranslationKey; desc: TranslationKey }[] = [
  { value: 'merge-skip', label: 'importModeSkip', desc: 'importModeSkipDesc' },
  { value: 'merge-copy', label: 'importModeCopy', desc: 'importModeCopyDesc' },
  { value: 'replace', label: 'importModeReplace', desc: 'importModeReplaceDesc' },
]

/** 导入方式的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={historyImport.mode === 'replace' ? 'dangerOutlined' : 'outlined'}
            size="m"
            onClick={() => void historyImport.confirm()}
          >
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
      <div className={styles.importModes} role="radiogroup" aria-label={t('importMode')}>
        {importModes.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={historyImport.mode === option.value}
            disabled={historyImport.busy}
            className={clsx(
              styles.importMode,
              historyImport.mode === option.value && styles.importModeActive
            )}
            onClick={() => historyImport.setMode(option.value)}
          >
            <span className={styles.importModeTitle}>{t(option.label)}</span>
            <span className={styles.importModeDesc}>{t(option.desc)}</span>
          </button>
        ))}
      </div>
      <div className={styles.importOptions}>
        <label className={styles.importOption}>
          <input
            type="checkbox"
            checked={historyImport.keepToolRecords}
            disabled={historyImport.busy}
            onChange={(event) => historyImport.setKeepToolRecords(event.target.checked)}
          />
          <span className={styles.importOptionText}>
            <span className={styles.importOptionTitle}>{t('importKeepTools')}</span>
            <span className={styles.importOptionDesc}>{t('importKeepToolsDesc')}</span>
          </span>
        </label>
        <label className={styles.importOption}>
          <input
            type="checkbox"
            checked={historyImport.keepImages}
            disabled={historyImport.busy}
            onChange={(event) => historyImport.setKeepImages(event.target.checked)}
          />
          <span className={styles.importOptionText}>
            <span className={styles.importOptionTitle}>{t('importKeepImages')}</span>
            <span className={styles.importOptionDesc}>{t('importKeepImagesDesc')}</span>
          </span>
        </label>
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge-skip')
  const [keepToolRecords, setKeepToolRecords] = useState(true)
  const [keepImages, setKeepImages] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const count = await importHistory(file, mode, {
        toolRecords: keepToolRecords,
        images: keepImages,
      })
      setStatus({
        key:
          mode === 'replace'
            ? count === 1
              ? 'historyImportedOne'
              : 'historyImported'
            : count === 1
              ? 'historyMergedOne'
              : 'historyMerged',
        params: { count },
      })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return {
    file,
    mode,
    setMode,
    keepToolRecords,
    setKeepToolRecords,
    keepImages,
    setKeepImages,
    busy,
    status,
    select: setFile,
    cancel: () => setFile(null),
    confirm,
  }
}

/** 导入：可选覆盖，或合并（跳过重复 / 冲突另存副本）。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
