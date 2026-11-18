export type TitleInput = {
  user: string
  assistant: string
}

export const generateTitle = async (input: TitleInput): Promise<string> => {
  const response = await fetch('/api/ai/title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chat-Local': '1' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `标题生成失败（${response.status}）`)
  }
  const body = (await response.json()) as { title?: string }
  return typeof body.title === 'string' ? body.title.trim() : ''
}
