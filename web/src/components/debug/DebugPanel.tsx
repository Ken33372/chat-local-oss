import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  loadDebugLogs,
  loadDebugStatus,
  PROBE_TARGETS,
  runDebugProbe,
  type DebugLogLine,
  type DebugProbeResult,
  type DebugStatus,
} from '../../services/debug.js'
import { useDebugPanel } from './debugPanelState.js'
import styles from './DebugPanel.module.css'

type Tab = 'status' | 'logs' | 'probe'
const LEVELS = ['ALL', 'INFO', 'WARNING', 'ERROR'] as const

/** 连点标题触发的调试面板：状态、后端日志、主动探针 */
export const DebugPanel = () => {
  const t = useTranslate()
  const open = useDebugPanel((state) => state.open)
  const closePanel = useDebugPanel((state) => state.closePanel)
  const [tab, setTab] = useState<Tab>('status')
  const [status, setStatus] = useState<DebugStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [logs, setLogs] = useState<DebugLogLine[]>([])
  const lastSeq = useRef(0)
  const [follow, setFollow] = useState(true)
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('ALL')
  const [probeBusy, setProbeBusy] = useState('')
  const [results, setResults] = useState<DebugProbeResult[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const pull = async () => {
      try {
        setStatus(await loadDebugStatus())
        setStatusError('')
      } catch (error) {
        setStatusError(error instanceof Error ? error.message : String(error))
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 5000)
    return () => clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open || tab !== 'logs') {
      return
    }
    let stopped = false
    // 每次进入日志页都从缓冲区重取，避免后端重启后 seq 归零导致「没有新日志」
    lastSeq.current = 0
    setLogs([])
    const pull = async () => {
      try {
        const data = await loadDebugLogs(lastSeq.current)
        if (stopped) {
          return
        }
        lastSeq.current = data.last
        if (data.lines.length) {
          setLogs((current) => [...current, ...data.lines].slice(-800))
        }
      } catch {
        // 后端未就绪时由状态页报错，这里保持安静
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [open, tab])

  useEffect(() => {
    if (tab === 'logs' && follow && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs, follow, tab])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePanel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closePanel])

  if (!open) {
    return null
  }

  const probe = async (target: string) => {
    setProbeBusy(target)
    try {
      const result = await runDebugProbe(target)
      setResults((current) => [result, ...current].slice(0, 20))
    } catch (error) {
      setResults((current) =>
        [
          {
            target,
            ok: false,
            ms: 0,
            detail: error instanceof Error ? error.message : String(error),
          },
          ...current,
        ].slice(0, 20)
      )
    } finally {
      setProbeBusy('')
    }
  }

  const probeAll = async () => {
    for (const target of PROBE_TARGETS) {
      if (target === 'asr' && status && !status.asr.ok) {
        continue
      }
      if (target === 'tts' && status && !status.tts.ok) {
        continue
      }
      await probe(target)
    }
  }

  const visible = level === 'ALL' ? logs : logs.filter((line) => line.level === level)
  const yes = (value: boolean) => (value ? t('debugYes') : t('debugNo'))

  return (
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && closePanel()}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={t('debugTitle')}>
        <div className={styles.header}>
          <span className={styles.title}>{t('debugTitle')}</span>
          {status ? (
            <span className={styles.uptime}>
              {t('debugUptime')} {Math.round(status.app.uptime)}s
            </span>
          ) : null}
          <span className={styles.spacer} />
          <button type="button" className={styles.button} onClick={() => void loadDebugStatus().then(setStatus)}>
            {t('debugRefresh')}
          </button>
          <button type="button" className={styles.button} onClick={closePanel}>
            {t('debugClose')}
          </button>
        </div>

        <div className={styles.tabs}>
          {(['status', 'logs', 'probe'] as Tab[]).map((item) => (
            <button
              key={item}
              type="button"
              className={clsx(styles.tab, tab === item && styles.tabActive)}
              onClick={() => setTab(item)}
            >
              {t(item === 'status' ? 'debugTabStatus' : item === 'logs' ? 'debugTabLogs' : 'debugTabProbe')}
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {tab === 'status' ? (
            !status ? (
              <div className={styles.hint}>{statusError || t('memoryLoading')}</div>
            ) : (
              <div className={styles.grid}>
                <Card title="Core">
                  <Row label="capabilities" value={Object.entries(status.app.capabilities).filter(([, on]) => on).map(([name]) => name).join(', ') || '-'} />
                  <Row label="context limit" value={status.app.context_limit.toLocaleString()} />
                  <Row label="output limit" value={status.app.output_limit.toLocaleString()} />
                  <Row label="data dir" value={status.app.data_dir} />
                </Card>
                <Card title="Prompts" ok>
                  <Row label="cards" value={status.prompts.cards} />
                  <Row label="active" value={status.prompts.active || '—'} />
                  <Row label="chars" value={status.prompts.chars.toLocaleString()} />
                </Card>
                <Card title="LLM" ok={status.llm.configured}>
                  <Row label="provider" value={status.llm.provider} />
                  <Row label="model" value={status.llm.model || t('debugNotConfigured')} />
                  <Row label="base" value={status.llm.base || '-'} />
                </Card>
                <Card title="Embedding" ok={status.embedding.configured}>
                  <Row label="model" value={status.embedding.model || t('debugNotConfigured')} />
                  <Row label="dim" value={status.embedding.dim || '-'} />
                  <Row label="key" value={yes(status.embedding.has_key)} />
                  <Row label="base" value={status.embedding.base || '-'} />
                </Card>
                <Card title="Memory · vectors" ok={status.memory.vectors > 0 || status.memory.items === 0}>
                  <Row label="items" value={status.memory.items} />
                  <Row label="pinned" value={status.memory.pinned} />
                  <Row label="vectors" value={status.memory.vectors} />
                  <Row label="missing" value={status.memory.vectors_missing} ok={status.memory.vectors_missing === 0} />
                  <Row label="vector model" value={status.memory.vector_model || '-'} />
                  <Row label="vector dim" value={status.memory.vector_dim || '-'} />
                  <Row label="inject" value={`${status.memory.inject_mode} / ${status.memory.inject_count}`} />
                  <Row label="search" value={status.memory.search_mode} />
                  <Row label="threshold" value={status.memory.sim_threshold} />
                  <Row label="pending" value={status.memory.pending} />
                  <Row label={t('debugLastError')} value={status.memory.last_error || '-'} ok={!status.memory.last_error} />
                </Card>
                <Card
                  title="Rerank"
                  ok={status.rerank.configured && status.rerank.probed ? status.rerank.ok : undefined}
                >
                  <Row label="model" value={status.rerank.model || t('debugNotConfigured')} />
                  <Row label="probed" value={yes(status.rerank.probed)} />
                  <Row
                    label="ok"
                    value={status.rerank.probed ? yes(status.rerank.ok) : '—'}
                    ok={status.rerank.probed ? status.rerank.ok : undefined}
                  />
                  <Row label="detail" value={status.rerank.detail || '-'} />
                  <Row label="base" value={status.rerank.base_url || '-'} />
                </Card>
                <Card title="Search" ok={status.search.available}>
                  <Row label="provider" value={status.search.provider} />
                  <Row label="available" value={yes(status.search.available)} ok={status.search.available} />
                  <Row label="base" value={status.search.base || '-'} />
                  <Row
                    label="engines"
                    value={status.search.engines.probed ? status.search.engines.engines : '—'}
                    ok={status.search.engines.probed ? status.search.engines.ok === true : undefined}
                  />
                </Card>
                <Card title="ASR / OCR / TTS · configured">
                  <Row label="asr" value={`${String(status.asr.provider)} · ${yes(Boolean(status.asr.ok))}`} ok={Boolean(status.asr.ok)} />
                  <Row
                    label="parse"
                    value={`img:${String(status.ocr.image)} · doc:${String(status.ocr.document)}`}
                    ok={Boolean(status.ocr.ok)}
                  />
                  <Row
                    label="tts"
                    value={`${String(status.tts.provider)} · ${yes(Boolean(status.tts.ok))}${status.tts.voice ? ` · ${status.tts.voice}` : ''}`}
                    ok={Boolean(status.tts.ok)}
                  />
                </Card>
              </div>
            )
          ) : null}

          {tab === 'logs' ? (
            <>
              <div className={styles.toolbar}>
                <button type="button" className={styles.button} onClick={() => setFollow(!follow)}>
                  {t(follow ? 'debugPause' : 'debugFollow')}
                </button>
                <select
                  className={styles.select}
                  value={level}
                  onChange={(event) => setLevel(event.target.value as (typeof LEVELS)[number])}
                >
                  {LEVELS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    setLogs([])
                    setFollow(true)
                  }}
                >
                  {t('debugClear')}
                </button>
                <span className={styles.hint}>{logs.length} / 800</span>
              </div>
              <div className={styles.logs} ref={logRef}>
                {visible.length === 0 ? (
                  <div className={styles.hint}>{t('debugEmptyLogs')}</div>
                ) : (
                  visible.map((line) => (
                    <div key={line.seq} className={clsx(styles.logLine, styles[`level${line.level}` as keyof typeof styles])}>
                      <span className={styles.logTime}>{line.ts}</span>
                      <span className={styles.logName}>{line.name}</span>
                      <span>{line.text}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}

          {tab === 'probe' ? (
            <>
              <div className={styles.toolbar}>
                <button type="button" className={styles.button} disabled={Boolean(probeBusy)} onClick={() => void probeAll()}>
                  {probeBusy ? `${t('debugProbing')} ${probeBusy}` : t('debugProbeAll')}
                </button>
                <span className={styles.hint}>{t('debugProbeHint')}</span>
              </div>
              <div className={styles.probeGrid}>
                {PROBE_TARGETS.map((target) => {
                  const off =
                    (target === 'asr' && status && !status.asr.ok) ||
                    (target === 'tts' && status && !status.tts.ok)
                  return (
                    <button
                      key={target}
                      type="button"
                      className={styles.probeButton}
                      disabled={Boolean(probeBusy) || Boolean(off)}
                      title={off ? t('debugNotConfigured') : undefined}
                      onClick={() => void probe(target)}
                    >
                      {probeBusy === target
                        ? t('debugProbing')
                        : `${target}${off ? ` · ${t('debugNotConfigured')}` : ''}`}
                    </button>
                  )
                })}
              </div>
              <div className={styles.results}>
                {results.map((result, index) => (
                  <div key={`${result.target}-${index}`} className={styles.resultRow}>
                    <span
                      className={clsx(
                        styles.dot,
                        result.state === 'warn'
                          ? styles.dotWarn
                          : result.ok
                            ? styles.dotOk
                            : styles.dotBad
                      )}
                    />
                    <span className={styles.resultTarget}>{result.target}</span>
                    <span className={styles.resultMs}>{result.ms}ms</span>
                    <span className={styles.resultDetail}>
                      {result.state === 'warn' ? `${t('debugWarn')} · ` : ''}
                      {result.detail}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const Card = ({ title, ok, children }: { title: string; ok?: boolean; children: ReactNode }) => (
  <section className={styles.card}>
    <div className={styles.cardTitle}>
      {ok === undefined ? null : <span className={clsx(styles.dot, ok ? styles.dotOk : styles.dotBad)} />}
      {title}
    </div>
    {children}
  </section>
)

const Row = ({ label, value, ok }: { label: string; value: ReactNode; ok?: boolean }) => (
  <div className={styles.row}>
    <span className={styles.rowLabel}>{label}</span>
    <span className={clsx(styles.rowValue, ok === true && styles.good, ok === false && styles.bad)}>{value}</span>
  </div>
)
