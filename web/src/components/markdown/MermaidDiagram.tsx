import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useState } from 'react'
import { useTheme } from '../../app/theme.js'
import { renderMermaid } from '../../services/markdown/mermaid.js'

/** 未闭合代码块只显示等待状态；闭合后按完整代码绘制一次，失败才展示错误。 */
export const MermaidDiagram = memo(function MermaidDiagram({
  code,
  loading,
}: {
  code: string
  loading: boolean
}) {
  const t = useTranslate()
  const dark = useTheme() === 'dark'
  const [result, setResult] = useState({ svg: '', failedCode: null as string | null })

  useEffect(() => {
    if (loading || !code.trim()) {
      return
    }
    let cancelled = false
    const draw = async () => {
      try {
        const svg = await renderMermaid(code, dark, () => cancelled)
        if (svg && !cancelled) {
          setResult({ svg, failedCode: null })
        }
      } catch {
        if (!cancelled) {
          setResult({ svg: '', failedCode: code })
        }
      }
    }
    void draw()
    return () => {
      cancelled = true
    }
  }, [dark, loading, code])

  if (!code.trim() || !result.svg) {
    return (
      <div className="md-mermaid-status" role="status">
        {!loading && !code.trim()
          ? t('mermaidEmpty')
          : !loading && result.failedCode === code
            ? t('mermaidRenderFail')
            : t('mermaidLoading')}
      </div>
    )
  }

  return <div className="md-mermaid-diagram" dangerouslySetInnerHTML={{ __html: result.svg }} />
})
