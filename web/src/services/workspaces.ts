import { create } from 'zustand'
import { request } from './api/client.js'
import { useChatStore, waitForSessionSave } from './chat/store.js'

/** 工作区只组织会话；null 的会话属于未分组。 */
export type Workspace = {
  id: string
  name: string
  cardId: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type WorkspacePatch = Partial<Pick<Workspace, 'name' | 'cardId' | 'sortOrder'>>
export type DeleteWorkspaceResult = { ok: boolean; moved: number }

const guard = { 'X-Chat-Local': '1', 'Content-Type': 'application/json' }

const send = async <T>(url: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> => {
  const response = await request(url, {
    method,
    headers: guard,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 204) {
    return undefined as T
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** 创建与重命名接口可能直接返回工作区，也可能包在 workspace 字段中。 */
const readWorkspace = (body: Workspace | { workspace: Workspace }): Workspace => {
  const workspace = 'workspace' in body ? body.workspace : body
  return { ...workspace, cardId: workspace.cardId ?? null }
}

export const listWorkspaces = async (): Promise<Workspace[]> => {
  const body = await send<{ workspaces: Workspace[] }>('/api/chat/workspaces', 'GET')
  return body.workspaces.map(readWorkspace)
}

export const createWorkspaceApi = async (
  name: string,
  cardId?: string | null
): Promise<Workspace> =>
  readWorkspace(
    await send<Workspace | { workspace: Workspace }>('/api/chat/workspaces', 'POST', {
      name,
      ...(cardId === undefined ? {} : { cardId }),
    })
  )

export const updateWorkspaceApi = async (id: string, patch: WorkspacePatch): Promise<Workspace> =>
  readWorkspace(
    await send<Workspace | { workspace: Workspace }>(
      `/api/chat/workspaces/${encodeURIComponent(id)}`,
      'PATCH',
      patch
    )
  )

export const deleteWorkspaceApi = async (id: string): Promise<DeleteWorkspaceResult> => {
  const result = await send<DeleteWorkspaceResult>(
    `/api/chat/workspaces/${encodeURIComponent(id)}`,
    'DELETE'
  )
  if (!result.ok) {
    throw new Error('Workspace deletion was not confirmed by the server')
  }
  return result
}

/** 只改归属，不发送完整会话，避免覆盖正在生成或编辑的消息。 */
export const moveSessionApi = async (sessionId: string, workspaceId: string | null): Promise<void> => {
  await send<unknown>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/workspace`, 'PATCH', {
    workspaceId,
  })
}

const sortWorkspaces = (items: Workspace[]) =>
  [...items].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.name.localeCompare(b.name)
  )

const errorMessage = (error: unknown) => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return String(error)
}

type WorkspaceState = {
  items: Workspace[]
  /** null 表示全部对话，不是未分组。 */
  selectedId: string | null
  loaded: boolean
  loading: boolean
  /** 加载或操作失败；界面必须显示并允许重试。 */
  error: string | null
}

export const useWorkspaceStore = create<WorkspaceState>(() => ({
  items: [],
  selectedId: null,
  loaded: false,
  loading: false,
  error: null,
}))

let loadTask: Promise<void> | undefined
let loadSequence = 0

export const loadWorkspaces = async (force = false): Promise<void> => {
  const state = getWorkspaceState()
  if (!force && state.loaded) {
    return
  }
  if (loadTask) {
    return loadTask
  }
  const sequence = ++loadSequence
  useWorkspaceStore.setState({ loading: true, error: null })
  const task = (async () => {
    try {
      const items = sortWorkspaces(await listWorkspaces())
      useWorkspaceStore.setState((current) => ({
        items,
        loaded: true,
        loading: false,
        error: null,
        // 工作区在别处被删除后，不能继续显示一个空筛选器。
        selectedId:
          current.selectedId !== null && !items.some((item) => item.id === current.selectedId)
            ? null
            : current.selectedId,
      }))
    } catch (error) {
      useWorkspaceStore.setState({ loading: false, error: errorMessage(error) })
      throw error
    } finally {
      if (sequence === loadSequence) {
        loadTask = undefined
      }
    }
  })()
  loadTask = task
  return task
}

const getWorkspaceState = () => useWorkspaceStore.getState()

export const selectWorkspace = (id: string | null) => {
  if (id === null || getWorkspaceState().items.some((item) => item.id === id)) {
    useWorkspaceStore.setState({ selectedId: id })
  }
}

export const createWorkspace = async (input: string, cardId?: string | null): Promise<Workspace> => {
  const name = input.trim()
  if (!name) {
    const error = new Error('Workspace name is required')
    useWorkspaceStore.setState({ error: error.message })
    throw error
  }
  useWorkspaceStore.setState({ error: null })
  try {
    const workspace = await createWorkspaceApi(name, cardId)
    useWorkspaceStore.setState((state) => ({
      items: sortWorkspaces([...state.items, workspace]),
      selectedId: workspace.id,
      error: null,
    }))
    return workspace
  } catch (error) {
    useWorkspaceStore.setState({ error: errorMessage(error) })
    throw error
  }
}

export const renameWorkspace = async (id: string, input: string): Promise<Workspace> => {
  const name = input.trim()
  if (!name) {
    const error = new Error('Workspace name is required')
    useWorkspaceStore.setState({ error: error.message })
    throw error
  }
  useWorkspaceStore.setState({ error: null })
  try {
    const workspace = await updateWorkspaceApi(id, { name })
    useWorkspaceStore.setState((state) => ({
      items: sortWorkspaces(state.items.map((item) => (item.id === id ? workspace : item))),
      error: null,
    }))
    return workspace
  } catch (error) {
    useWorkspaceStore.setState({ error: errorMessage(error) })
    throw error
  }
}

export const setWorkspaceCard = async (id: string, cardId: string | null): Promise<Workspace> => {
  const current = getWorkspaceState().items.find((item) => item.id === id)
  if (current?.cardId === cardId) {
    return current
  }
  useWorkspaceStore.setState({ error: null })
  try {
    const workspace = await updateWorkspaceApi(id, { cardId })
    useWorkspaceStore.setState((state) => ({
      items: state.items.map((item) => (item.id === id ? workspace : item)),
      error: null,
    }))
    return workspace
  } catch (error) {
    useWorkspaceStore.setState({ error: errorMessage(error) })
    throw error
  }
}

/** 服务端已确认移动；这里只同步列表和已加载详情，不再 PUT 整份会话。 */
const applySessionWorkspace = (sessionId: string, workspaceId: string | null) => {
  useChatStore.setState((state) => {
    const cached = Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
    if (
      !state.sessions.some((session) => session.id === sessionId) &&
      (!cached || cached.workspaceId === workspaceId)
    ) {
      return state
    }
    return {
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, workspaceId } : session
      ),
      sessionCache: cached
        ? { ...state.sessionCache, [sessionId]: { ...cached, workspaceId } }
        : state.sessionCache,
    }
  })
}

/** 删除工作区后，后端已将其中全部会话移入未分组（包含已归档会话）。 */
const unassignWorkspaceSessions = (workspaceId: string) => {
  useChatStore.setState((state) => {
    const sessionChanged = state.sessions.some((session) => session.workspaceId === workspaceId)
    const cacheChanged = Object.values(state.sessionCache).some(
      (session) => session.workspaceId === workspaceId
    )
    if (!sessionChanged && !cacheChanged) {
      return state
    }
    return {
      sessions: state.sessions.map((session) =>
        session.workspaceId === workspaceId ? { ...session, workspaceId: null } : session
      ),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).map(([id, session]) => [
          id,
          session.workspaceId === workspaceId ? { ...session, workspaceId: null } : session,
        ])
      ),
    }
  })
}

const moveTasks = new Map<string, Promise<void>>()
const isNotFound = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 404

export const moveSession = (sessionId: string, workspaceId: string | null): Promise<void> => {
  const previous = moveTasks.get(sessionId) ?? Promise.resolve()
  const task = previous
    .catch(() => {})
    .then(async () => {
      useWorkspaceStore.setState({ error: null })
      try {
        try {
          await moveSessionApi(sessionId, workspaceId)
        } catch (error) {
          if (!isNotFound(error)) {
            throw error
          }
          // 新会话的首存可能还没完成；等这次落盘后重试，不阻塞整个流式回复。
          await waitForSessionSave(sessionId)
          await moveSessionApi(sessionId, workspaceId)
        }
        applySessionWorkspace(sessionId, workspaceId)
      } catch (error) {
        useWorkspaceStore.setState({ error: errorMessage(error) })
        throw error
      }
    })
    .finally(() => {
      if (moveTasks.get(sessionId) === task) {
        moveTasks.delete(sessionId)
      }
    })
  moveTasks.set(sessionId, task)
  return task
}

export const deleteWorkspace = async (id: string): Promise<DeleteWorkspaceResult> => {
  useWorkspaceStore.setState({ error: null })
  try {
    const result = await deleteWorkspaceApi(id)
    useWorkspaceStore.setState((state) => ({
      items: state.items.filter((item) => item.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
      error: null,
    }))
    unassignWorkspaceSessions(id)
    useChatStore.setState((state) => ({
      pendingWorkspaceId: state.pendingWorkspaceId === id ? null : state.pendingWorkspaceId,
    }))
    return result
  } catch (error) {
    useWorkspaceStore.setState({ error: errorMessage(error) })
    throw error
  }
}
