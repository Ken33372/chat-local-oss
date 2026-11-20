import { useEffect, useRef, useState } from 'react'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import {
  clearUsage,
  loadUsageSummary,
  saveUsagePricing,
  type UsageBucket,
  type UsagePricing,
  type UsageSummary,
} from '../../services/usage.js'
import styles from './Settings.module.css'

const RANGES = [7, 30, 90]

const num = (value: number) => value.toLocaleString()
const money = (value: number, currency: string) =>
  `${currency === 'USD' ? '$' : '¥'}${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`
const rate = (value: number) => `${(value * 100).toFixed(1)}%`

/**
 * 设置 → 使用统计：汇总卡、按天与按模型两张表、可编辑单价。
 * 数据由每轮对话结束后上报，只统计对话请求。
 */
export const UsageSettingsPanel = () => {
  const t = useTranslate()
  const [days, setDays] = useState(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<UsagePricing | null>(null)
  const [saving, setSaving] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const [clearing, setClearing] = useState(false)
  const priced = useRef(false)

  const load = async (range: number) => {
    const next = await loadUsageSummary(range)
    setSummary(next)
    if (!priced.current) {
      priced.current = true
      setDraft(next.pricing)
    }
  }

  useEffect(() => {
    let alive = true
    setError('')
    load(days).catch((reason) => {
      if (alive) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })
    return () => {
      alive = false
    }
    // day 切换时才重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  const save = async () => {
    if (!draft || saving) {
      return
    }
    setSaving(true)
    try {
      const saved = await saveUsagePricing(draft)
      setDraft(saved)
      await load(days)
      showToast({ key: 'usageSaved' })
    } catch (reason) {
      showToast({
        key: 'usageFailed',
        params: { message: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const wipe = async () => {
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    setClearArmed(false)
    setClearing(true)
    try {
      await clearUsage()
      await load(days)
      showToast({ key: 'usageCleared' })
    } catch (reason) {
      showToast({
        key: 'usageFailed',
        params: { message: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    } finally {
      setClearing(false)
    }
  }

  const price = (key: 'input' | 'cache_read' | 'output') => (
    <label className={styles.usagePriceField}>
      <span>{t(key === 'input' ? 'usagePriceInput' : key === 'cache_read' ? 'usagePriceCache' : 'usagePriceOutput')}</span>
      <input
        className={styles.memoryInput}
        type="number"
        min={0}
        step="0.01"
        value={draft?.[key] ?? 0}
        disabled={!draft || saving}
        onChange={(event) => {
          if (draft) {
            setDraft({ ...draft, [key]: Number(event.target.value) || 0 })
          }
        }}
      />
    </label>
  )

  const row = (item: UsageBucket & { date?: string; model?: string; mode?: string }, index: number) => (
    <tr key={item.date ?? `${item.model}-${item.mode}-${index}`}>
      {item.date ? <td>{item.date}</td> : null}
      {item.model !== undefined ? (
        <>
          <td className={styles.usageModelCell}>{item.model || t('usageUnnamedModel')}</td>
          <td>{item.mode === 'cloud' ? t('usageModeCloud') : item.mode === 'local' ? t('usageModeLocal') : '—'}</td>
        </>
      ) : null}
      <td>{num(item.calls)}</td>
      <td>{num(item.input + item.cache_creation)}</td>
      <td>{num(item.cache_read)}</td>
      <td>{num(item.output)}</td>
      <td>{money(item.cost, summary?.pricing.currency ?? 'CNY')}</td>
    </tr>
  )

  const head = (withDate: boolean) => (
    <thead>
      <tr>
        {withDate ? <th>{t('usageDate')}</th> : <><th>{t('usageModel')}</th><th>{t('usageMode')}</th></>}
        <th>{t('usageCalls')}</th>
        <th>{t('usageInput')}</th>
        <th>{t('usageCacheRead')}</th>
        <th>{t('usageOutput')}</th>
        <th>{t('usageCost')}</th>
      </tr>
    </thead>
  )

  return (
    <div className={styles.memoryPanel}>
      <div className={styles.memoryHint}>{t('usageHint')}</div>
      <div className={styles.usageRange}>
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            className={range === days ? styles.usageRangeActive : styles.usageRangeButton}
            onClick={() => setDays(range)}
          >
            {t('usageRange', { days: String(range) })}
          </button>
        ))}
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
      {!summary ? (
        <div className={styles.memoryNotice}>{t('memoryLoading')}</div>
      ) : (
        <>
          <div className={styles.usageCards}>
            <div className={styles.usageCard}>
              <div className={styles.usageCardLabel}>{t('usageCalls')}</div>
              <div className={styles.usageCardValue}>{num(summary.totals.calls)}</div>
            </div>
            <div className={styles.usageCard}>
              <div className={styles.usageCardLabel}>{t('usageInput')}</div>
              <div className={styles.usageCardValue}>{num(summary.totals.input + summary.totals.cache_creation)}</div>
            </div>
            <div className={styles.usageCard}>
              <div className={styles.usageCardLabel}>{t('usageCacheRead')}</div>
              <div className={styles.usageCardValue}>{num(summary.totals.cache_read)}</div>
            </div>
            <div className={styles.usageCard}>
              <div className={styles.usageCardLabel}>{t('usageOutput')}</div>
              <div className={styles.usageCardValue}>{num(summary.totals.output)}</div>
            </div>
            <div className={styles.usageCard}>
              <div className={styles.usageCardLabel}>{t('usageHitRate')}</div>
              <div className={styles.usageCardValue}>{rate(summary.totals.hit_rate)}</div>
            </div>
            <div className={styles.usageCard}>
              <div className={styles.usageCardLabel}>{t('usageCost')}</div>
              <div className={styles.usageCardValue}>
                {money(summary.totals.cost, summary.pricing.currency)}
              </div>
            </div>
          </div>

          <div className={styles.memorySection}>
            <div className={styles.memorySectionTitle}>{t('usageDaily')}</div>
            {summary.daily.length ? (
              <div className={styles.usageTableWrap}>
                <table className={styles.usageTable}>
                  {head(true)}
                  <tbody>{[...summary.daily].reverse().map((item, index) => row(item, index))}</tbody>
                </table>
              </div>
            ) : (
              <div className={styles.memoryHint}>{t('usageEmpty')}</div>
            )}
          </div>

          {summary.models.length ? (
            <div className={styles.memorySection}>
              <div className={styles.memorySectionTitle}>{t('usageModels')}</div>
              <div className={styles.usageTableWrap}>
                <table className={styles.usageTable}>
                  {head(false)}
                  <tbody>{summary.models.map((item, index) => row(item, index))}</tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className={styles.memorySection}>
            <div className={styles.memorySectionTitle}>{t('usagePricing')}</div>
            <div className={styles.memoryHint}>{t('usagePricingHint')}</div>
            <div className={styles.usagePriceFields}>
              {price('input')}
              {price('cache_read')}
              {price('output')}
              <label className={styles.usagePriceField}>
                <span>{t('usageCurrency')}</span>
                <Select
                  ariaLabel={t('usageCurrency')}
                  value={draft?.currency ?? 'CNY'}
                  options={[
                    { value: 'CNY', label: 'CNY' },
                    { value: 'USD', label: 'USD' },
                  ]}
                  onChange={(value) => draft && setDraft({ ...draft, currency: value as 'CNY' | 'USD' })}
                />
              </label>
            </div>
            <div className={styles.memoryFooter}>
              <Button variant="outlined" size="m" disabled={!draft || saving} onClick={() => void save()}>
                {t('usageSave')}
              </Button>
            </div>
          </div>

          <div className={styles.memorySection}>
            <div className={styles.memorySectionTitle}>{t('usageClearTitle')}</div>
            <div className={styles.memoryHint}>{t('usageClearHint')}</div>
            <div className={styles.memoryFooter}>
              <Button
                variant="dangerOutlined"
                size="m"
                disabled={clearing}
                onClick={() => void wipe()}
              >
                {clearArmed ? t('usageClearConfirm') : t('usageClear')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
