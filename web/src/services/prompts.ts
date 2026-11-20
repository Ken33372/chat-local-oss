const guard = { 'X-Chat-Local': '1', 'Content-Type': 'application/json' }

export type PromptCard = {
  id: string
  name: string
  description: string
  text: string
}

export type PromptsState = {
  active: string
  cards: PromptCard[]
}

export const loadPrompts = async (): Promise<PromptsState> => {
  const response = await fetch('/api/prompts')
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as PromptsState
}

export const savePrompts = async (state: PromptsState): Promise<PromptsState> => {
  const response = await fetch('/api/prompts', {
    method: 'PATCH',
    headers: guard,
    body: JSON.stringify(state),
  })
  const body = (await response.json().catch(() => ({}))) as { detail?: string }
  if (!response.ok) {
    throw new Error(body.detail || `HTTP ${response.status}`)
  }
  return body as PromptsState
}
