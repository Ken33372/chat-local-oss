// Offline regressions: Node.js 22.13+ with npm test; no real services or user data.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate)
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200 })
const usage = (input = 10, output = 2) => ({
  input_tokens: input, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: output,
})
const session = (id = 's') => ({
  id, title: 'before', createdAt: 1, updatedAt: 1, workspaceId: null,
  messages: [], rootMessageId: null,
})
function memoryStorage() {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }
}
function createStore(init) {
  let state = init()
  const listeners = new Set()
  const store = (select) => select(state)
  store.getState = () => state
  store.setState = (update) => {
    state = { ...state, ...(typeof update === 'function' ? update(state) : update) }
    for (const listener of listeners) listener(state)
  }
  store.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
  return store
}

async function sandbox(entry, stubs = {}, globals = {}, transform = (source) => source) {
  const timers = new Map()
  let timerId = 0
  const context = vm.createContext({
    console: { ...console, error: () => {}, warn: () => {} },
    Response, Request, Headers, Blob, File, FormData, AbortController, AbortSignal,
    TextDecoder, TextEncoder, ReadableStream, URL,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    document: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    localStorage: memoryStorage(),
    fetch: () => { throw new Error('Unexpected fetch: all network must be mocked') },
    ...globals,
  })
  const modules = new Map()
  function getModule(name) {
    if (!modules.has(name)) {
      modules.set(name, (async () => {
        const stubKey = Object.keys(stubs).find((key) => name === key || name.replaceAll('\\', '/').endsWith(key))
        if (stubKey) {
          const exports = stubs[stubKey]
          return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
          }, { context, identifier: name })
        }
        if (!name.startsWith(root)) throw new Error(`Unmocked import ${name}`)
        const source = transform(await readFile(name, 'utf8'), name)
        return new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), { context, identifier: name })
      })())
    }
    return modules.get(name)
  }
  const module = await getModule(path.join(root, entry))
  await module.link((specifier, parent) => {
    const target = specifier.startsWith('.')
      ? path.resolve(path.dirname(parent.identifier), specifier).replace(/\.js$/, '.ts')
      : specifier
    return getModule(target)
  })
  await module.evaluate()
  return { api: module.namespace, context, timers }
}

async function chat(options = {}) {
  let settings = { mode: 'cloud', apiKey: 'mock-key', maxToolRounds: 3, thinking: false, search: false, autoTitle: false }
  const useSettings = Object.assign((select) => select(settings), { getState: () => settings })
  const records = [], requests = [], writes = [], order = []
  const disk = new Map()
  let nextId = 0
  const apiError = class extends Error {}
  const stubs = {
    zustand: { create: createStore },
    '/utils/id.ts': { createId: () => `id-${++nextId}` },
    '/services/api/client.ts': {
      ApiError: apiError,
      streamMessage: async function* (...args) {
        requests.push(args)
        if (options.stream) yield* options.stream(...args)
      },
    },
    '/services/api/errors.ts': { extractFileIds: () => [], getFileErrorCode: () => null, isRetryableApiError: () => false },
    '/services/settings.ts': { useSettings },
    '/services/attachments.ts': {
      cancelUpload() {}, describeUploadError: (error) => error.message,
      uploadAttachment: (...args) => options.upload?.(...args), useUploads: { getState: () => ({ tasks: {} }) },
    },
    '/services/context.ts': { buildCompressionInput: () => null, requestCompression: () => { throw Error('Unexpected compression') } },
    '/services/usage.ts': { recordUsage: async (event) => records.push(plain(event)) },
    '/services/capabilities.ts': { useCapabilities: { getState: () => ({ contextLimit: 30000 }) } },
    '/chat/drafts.ts': { clearAllDrafts() {}, clearDraft() {}, clearSentDraft() {}, getDraft() {}, prepareDraftMessage: () => options.draft },
    '/chat/latestReminder.ts': { createLatestReminder: () => '' },
    '/chat/title.ts': { generateTitle: () => { throw Error('Unexpected title generation') } },
  }
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    order.push(`${method} ${url}`)
    if (options.fetch) {
      const result = options.fetch(url, init)
      if (result !== undefined) return result
    }
    if (url === '/api/chat/staging/clear') return ok()
    if (url === '/api/chat/staging/commit') return ok({ sessions: [], added: 0 })
    if (url.startsWith('/api/chat/files/')) return method === 'GET' ? new Response('blob') : ok()
    const match = /^\/api\/chat\/sessions\/([^/]+)(\/archive)?$/.exec(url)
    if (match) {
      const id = match[1]
      if (method === 'PUT') {
        const body = JSON.parse(init.body)
        writes.push(body)
        await options.write?.(body)
        disk.set(id, body)
      } else if (method === 'DELETE') {
        disk.delete(id)
      } else if (method === 'GET') return ok(disk.get(id))
      return ok()
    }
    if (url === '/api/chat/sessions') return ok({ sessions: [...disk.values()] })
    throw new Error(`Unexpected mock route ${method} ${url}`)
  }
  const env = await sandbox('src/services/chat/store.ts', stubs, { fetch })
  const seed = (value = session()) => {
    disk.set(value.id, value)
    env.api.useChatStore.setState({ ready: true, sessions: [value], sessionCache: { [value.id]: value }, activeId: value.id })
  }
  return { ...env, seed, disk, writes, order, records, requests, setSettings: (next) => { settings = { ...settings, ...next } } }
}

async function workspaceStore(handler, waitForSessionSave = async () => {}) {
  const cached = { ...session('s'), workspaceId: 'w1' }
  const chatStore = createStore(() => ({
    sessions: [cached, { ...session('s2'), workspaceId: 'w2', archived: true }],
    sessionCache: { s: cached },
    pendingWorkspaceId: null,
  }))
  const calls = []
  const env = await sandbox('src/services/workspaces.ts', {
    zustand: { create: createStore },
    '/services/api/client.ts': {
      request: async (url, init) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body === undefined ? undefined : JSON.parse(init.body),
        })
        return handler(url, init)
      },
    },
    '/chat/store.ts': { useChatStore: chatStore, waitForSessionSave },
  })
  return { ...env, calls, chatStore }
}

const workspace = (id, sortOrder) => ({
  id, name: id, cardId: null, sortOrder, createdAt: sortOrder, updatedAt: sortOrder,
})

function continuedSession(files = []) {
  const s = session()
  s.messages = [
    { id: 'q', role: 'user', content: 'mock question', files, createdAt: 1 },
    { id: 'a', role: 'assistant', model: 'deepseek-flash', prefix: true, status: 'stopped', createdAt: 1,
      thinking: false, search: false, usage: usage(100, 50), blocks: [{ type: 'text', text: 'old context' }] },
  ]
  delete s.rootMessageId
  return s
}

test('session summaries preserve workspace membership and legacy records default to ungrouped', async () => {
  const env = await sandbox('src/services/chat/types.ts')
  const current = session()
  current.workspaceId = 'workspace-a'
  assert.equal(env.api.toSessionSummary(current).workspaceId, 'workspace-a')
  assert.equal(Object.hasOwn(env.api.toSessionSummary(current), 'messages'), false)
  const legacy = session()
  delete legacy.workspaceId
  assert.equal(env.api.toSessionSummary(legacy).workspaceId, null)
})

test('session normalization adds missing workspace membership without rewriting current records', async () => {
  const env = await sandbox('src/services/chat/branches.ts')
  const current = session()
  assert.equal(env.api.normalizeSession(current), current)
  const legacy = session()
  delete legacy.workspaceId
  const normalized = env.api.normalizeSession(legacy)
  assert.equal(normalized.workspaceId, null)
  assert.notEqual(normalized, legacy)
  assert.equal(env.api.normalizeSession(normalized), normalized)
  delete legacy.rootMessageId
  assert.equal(env.api.normalizeSession(legacy).rootMessageId, null)
})

test('new chats consume the selected workspace and explicit ungrouped overrides it', async () => {
  const env = await chat({ draft: { text: 'mock', files: [] } })
  env.setSettings({ mode: 'local' })
  env.api.useChatStore.setState({ ready: true })

  env.api.newChat('workspace-a')
  assert.equal(env.api.sendMessage(null), true)
  const firstId = env.api.useChatStore.getState().activeId
  assert.equal(env.api.useChatStore.getState().sessionCache[firstId].workspaceId, 'workspace-a')
  assert.equal(env.api.useChatStore.getState().sessions[0].workspaceId, 'workspace-a')

  env.api.newChat('workspace-a')
  assert.equal(env.api.sendMessage(null, null), true)
  const secondId = env.api.useChatStore.getState().activeId
  assert.equal(env.api.useChatStore.getState().sessionCache[secondId].workspaceId, null)

  env.api.newChat()
  assert.equal(env.api.sendMessage(null), true)
  const thirdId = env.api.useChatStore.getState().activeId
  assert.equal(env.api.useChatStore.getState().sessionCache[thirdId].workspaceId, null)

  await tick()
  assert.deepEqual(env.requests.map((request) => request[5]), ['workspace-a', null, null])
  assert.equal(env.requests.some((request) => Object.hasOwn(request[1], 'workspaceId')), false)
  // Each send persists more than once (initial, prepared, settled); every saved
  // snapshot must retain the same membership for that session.
  assert.deepEqual(
    Object.fromEntries(env.writes.map((value) => [value.id, value.workspaceId])),
    { [firstId]: 'workspace-a', [secondId]: null, [thirdId]: null }
  )
})

test('history imports create ungrouped sessions', async () => {
  const env = await sandbox('src/services/chat/history/toLocal.ts', {
    '/i18n/index.ts': { translate: (key) => key },
  })
  const imported = env.api.toLocalSession({
    id: 'imported', title: null, pinned: false, current_message_id: 0,
    inserted_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [],
  })
  assert.equal(imported.session.workspaceId, null)
  assert.equal(imported.session.rootMessageId, null)
})

test('workspace store loads, creates, renames, binds, moves and deletes with server confirmation', async () => {
  const disk = [workspace('w2', 2), workspace('w1', 1)]
  const env = await workspaceStore(async (url, init) => {
    const method = init.method ?? 'GET'
    if (url === '/api/chat/workspaces' && method === 'GET') return ok({ workspaces: disk })
    if (url === '/api/chat/workspaces' && method === 'POST') {
      const body = JSON.parse(init.body)
      const created = { ...workspace('w3', 3), name: body.name, cardId: body.cardId ?? null }
      disk.push(created)
      return ok(created)
    }
    const match = /^\/api\/chat\/workspaces\/([^/]+)$/.exec(url)
    if (match && method === 'PATCH') {
      const current = disk.find((item) => item.id === match[1])
      Object.assign(current, JSON.parse(init.body))
      return ok({ workspace: current })
    }
    if (match && method === 'DELETE') {
      const moved = 2
      disk.splice(disk.findIndex((item) => item.id === match[1]), 1)
      return ok({ ok: true, moved })
    }
    if (url === '/api/chat/sessions/s/workspace' && method === 'PATCH') {
      assert.deepEqual(JSON.parse(init.body), { workspaceId: 'w2' })
      return new Response(null, { status: 200 })
    }
    throw Error(`Unexpected workspace route ${method} ${url}`)
  })

  await env.api.loadWorkspaces()
  assert.deepEqual(plain(env.api.useWorkspaceStore.getState().items.map((item) => item.id)), ['w1', 'w2'])
  assert.equal(env.api.useWorkspaceStore.getState().selectedId, null)
  assert.equal(env.calls[0].headers['X-Chat-Local'], '1')

  const created = await env.api.createWorkspace('  New  ', 'card-a')
  assert.equal(created.name, 'New')
  assert.equal(env.api.useWorkspaceStore.getState().selectedId, 'w3')
  assert.deepEqual(env.calls[1].body, { name: 'New', cardId: 'card-a' })

  await env.api.renameWorkspace('w3', 'Renamed')
  assert.equal(env.api.useWorkspaceStore.getState().items.find((item) => item.id === 'w3').name, 'Renamed')
  await env.api.setWorkspaceCard('w3', null)
  assert.equal(env.api.useWorkspaceStore.getState().items.find((item) => item.id === 'w3').cardId, null)
  assert.deepEqual(env.calls[3].body, { cardId: null })

  await env.api.moveSession('s', 'w2')
  assert.equal(env.chatStore.getState().sessions[0].workspaceId, 'w2')
  assert.equal(env.chatStore.getState().sessionCache.s.workspaceId, 'w2')

  env.api.selectWorkspace('w2')
  env.chatStore.setState({ pendingWorkspaceId: 'w2' })
  assert.deepEqual(plain(await env.api.deleteWorkspace('w2')), { ok: true, moved: 2 })
  const workspaces = env.api.useWorkspaceStore.getState()
  assert.equal(workspaces.items.some((item) => item.id === 'w2'), false)
  assert.equal(workspaces.selectedId, null)
  assert.equal(env.chatStore.getState().pendingWorkspaceId, null)
  assert.deepEqual(plain(env.chatStore.getState().sessions.map((item) => item.workspaceId)), [null, null])
  assert.equal(env.chatStore.getState().sessionCache.s.workspaceId, null)
  assert.equal(env.calls.some((call) => call.method === 'PUT'), false)
})

test('workspace moves wait for a new session save and serialize overlapping requests', async () => {
  const save = deferred()
  const secondMove = deferred()
  const moves = []
  let saveWaits = 0
  const env = await workspaceStore(async (url, init) => {
    if (url === '/api/chat/sessions/s/workspace' && init.method === 'PATCH') {
      const workspaceId = JSON.parse(init.body).workspaceId
      moves.push(workspaceId)
      if (moves.length === 1) {
        throw Object.assign(new Error('session not saved'), { status: 404 })
      }
      if (moves.length === 2) {
        return ok()
      }
      await secondMove.promise
      return ok()
    }
    throw Error(`Unexpected route ${init.method} ${url}`)
  }, async () => {
    saveWaits += 1
    await save.promise
  })

  const first = env.api.moveSession('s', 'w2')
  const second = env.api.moveSession('s', null)
  await tick()
  assert.deepEqual(moves, ['w2'])
  assert.equal(saveWaits, 1)

  save.resolve()
  await first
  assert.deepEqual(moves.slice(0, 2), ['w2', 'w2'])
  assert.equal(env.chatStore.getState().sessionCache.s.workspaceId, 'w2')

  secondMove.resolve()
  await second
  assert.deepEqual(moves, ['w2', 'w2', null])
  assert.equal(env.chatStore.getState().sessions[0].workspaceId, null)
  assert.equal(env.chatStore.getState().sessionCache.s.workspaceId, null)
})

test('workspace store resets stale selection and exposes recoverable load and mutation errors', async () => {
  let failLoad = true
  let failCreate = true
  const disk = [workspace('w1', 1)]
  const env = await workspaceStore(async (url, init) => {
    const method = init.method ?? 'GET'
    if (method === 'GET') {
      if (failLoad) throw Error('mock load failed')
      return ok({ workspaces: disk })
    }
    if (method === 'POST') {
      if (failCreate) throw Error('mock create failed')
      return ok(workspace('w2', 2))
    }
    throw Error(`Unexpected route ${method} ${url}`)
  })

  await assert.rejects(env.api.loadWorkspaces(), /mock load failed/)
  let state = env.api.useWorkspaceStore.getState()
  assert.equal(state.error, 'mock load failed')
  assert.equal(state.loading, false)
  assert.equal(state.loaded, false)

  failLoad = false
  await env.api.loadWorkspaces(true)
  env.api.selectWorkspace('w1')
  disk.splice(0, 1)
  await env.api.loadWorkspaces(true)
  state = env.api.useWorkspaceStore.getState()
  assert.equal(state.selectedId, null)
  assert.equal(state.error, null)

  await assert.rejects(env.api.createWorkspace('X'), /mock create failed/)
  state = env.api.useWorkspaceStore.getState()
  assert.equal(state.error, 'mock create failed')
  assert.equal(state.items.length, 0)

  failCreate = false
  await env.api.createWorkspace('X')
  assert.equal(env.api.useWorkspaceStore.getState().error, null)
  assert.equal(env.api.useWorkspaceStore.getState().items.length, 1)
})

test('unassigned workspace remains a stable virtual filter and maps to null for chats', async () => {
  const disk = [workspace('w1', 1)]
  const env = await workspaceStore(async (url, init) => {
    if (url === '/api/chat/workspaces' && (init.method ?? 'GET') === 'GET') {
      return ok({ workspaces: disk })
    }
    throw Error(`Unexpected route ${init.method} ${url}`)
  })

  await env.api.loadWorkspaces()
  env.api.selectWorkspace(env.api.UNASSIGNED_WORKSPACE_ID)
  assert.equal(env.api.useWorkspaceStore.getState().selectedId, env.api.UNASSIGNED_WORKSPACE_ID)

  disk.splice(0, 1)
  await env.api.loadWorkspaces(true)
  assert.equal(env.api.useWorkspaceStore.getState().selectedId, env.api.UNASSIGNED_WORKSPACE_ID)
  assert.equal(env.api.toChatWorkspaceId(env.api.UNASSIGNED_WORKSPACE_ID), null)
  assert.equal(env.api.toChatWorkspaceId(null), null)
  assert.equal(env.api.toChatWorkspaceId('w1'), 'w1')
})

test('queued attachments keep their selected mode after a settings change', async () => {
  let mode = 'local'
  const barrier = deferred()
  const urls = []
  const env = await sandbox('src/services/attachments.ts', {
    zustand: { create: createStore },
    '/services/settings.ts': { useSettings: { getState: () => ({ mode }) } },
    '/services/api/client.ts': { uploadFile: () => { throw new Error('Unexpected cloud upload') } },
    '/services/api/errors.ts': {
      classifyApiError: () => ({}), getUploadErrorInfo: () => ({}), isRetryableApiError: () => false,
    },
  }, {
    fetch: async (url) => { urls.push(url); await barrier.promise; return ok() },
  })
  const uploads = [0, 1, 2, 3].map((id) =>
    env.api.uploadAttachment('', `file-${id}`, new Blob(['fixture']), 'test.txt', false))
  assert.equal(urls.length, 3)
  mode = 'cloud'
  barrier.resolve()
  await Promise.all(uploads)
  await env.api.uploadAttachment('', 'explicit', new Blob(['fixture']), 'test.txt', false, 'local')
  assert.equal(urls.length, 5)
  assert.ok(urls.every((url) => url.startsWith('/api/chat/files/')))
})

test('same-session saves serialize and coalesce to latest; idle waits for PUT', async () => {
  const first = deferred(), latest = deferred()
  const env = await chat({ write: (body) => body.title === 'one' ? first.promise : latest.promise })
  env.seed()
  env.api.renameSession('s', 'one')
  await tick()
  env.api.renameSession('s', 'two')
  env.api.renameSession('s', 'three')
  let idle = false
  const wait = env.api.stopAllReplies().then(() => { idle = true })
  await tick()
  assert.deepEqual(env.writes.map((s) => s.title), ['one'])
  assert.equal(idle, false)
  first.resolve()
  await tick()
  assert.deepEqual(env.writes.map((s) => s.title), ['one', 'three'])
  assert.equal(idle, false)
  latest.resolve()
  await wait
  assert.equal(env.disk.get('s').title, 'three')
})

test('workspace save wait drains the current PUT and reports persistence failure', async () => {
  for (const fail of [false, true]) {
    const saving = deferred()
    const env = await chat({ write: async () => { await saving.promise; if (fail) throw Error('mock disk full') } })
    env.seed()
    env.api.renameSession('s', 'unsaved')
    await tick()
    let settled = false
    const waiting = env.api.waitForSessionSave('s').finally(() => { settled = true })
    const outcome = fail
      ? assert.rejects(waiting, /尚未保存/)
      : waiting
    await tick()
    assert.equal(settled, false)
    saving.resolve()
    await outcome
    assert.equal(settled, true)
  }
})

test('archive waits for real persistence; failed save stays cached and retry succeeds', async () => {
  const saving = deferred()
  let fail = true
  const env = await chat({ write: async () => { await saving.promise; if (fail) throw Error('mock disk full') } })
  env.seed()
  env.api.renameSession('s', 'unsaved')
  await tick()
  const archive = env.api.setSessionArchived('s', true)
  await tick()
  assert.equal(env.order.some((item) => item.endsWith('/archive')), false)
  saving.resolve()
  assert.equal(await archive, false)
  assert.equal(env.api.useChatStore.getState().sessionCache.s.title, 'unsaved')
  assert.equal(env.api.useChatStore.getState().sessionSaveErrors.s, true)
  fail = false
  assert.equal(await env.api.setSessionArchived('s', true), true)
  assert.equal(env.disk.get('s').title, 'unsaved')
  assert.equal(env.api.useChatStore.getState().sessionCache.s, undefined)
})

test('delete drains in-flight PUT and discards queued saves, without revival', async () => {
  const saving = deferred()
  const env = await chat({ write: () => saving.promise })
  env.seed()
  env.api.renameSession('s', 'old-in-flight')
  await tick()
  env.api.renameSession('s', 'queued')
  const removal = env.api.removeSession('s')
  await tick()
  assert.equal(env.order.some((item) => item.startsWith('DELETE')), false)
  saving.resolve()
  assert.equal(await removal, true)
  await tick()
  assert.equal(env.writes.length, 1)
  assert.equal(env.disk.has('s'), false)
  assert.equal(env.api.useChatStore.getState().sessionCache.s, undefined)
})

test('replace waits for active save, drops queued old write, and failed replacement retries latest', async () => {
  for (const fail of [false, true]) {
    const saving = deferred()
    const env = await chat({ write: () => saving.promise })
    env.seed()
    env.api.renameSession('s', 'in-flight')
    await tick()
    env.api.renameSession('s', 'latest')
    let staging = false
    const replacement = env.api.replaceHistory(async () => {
      staging = true
      if (fail) throw Error('mock import failure')
    })
    const observed = replacement.catch((error) => error)
    await tick()
    assert.equal(staging, false)
    saving.resolve()
    await observed
    await tick()
    if (fail) {
      assert.equal(env.disk.get('s').title, 'latest')
      assert.equal(env.api.useChatStore.getState().sessionCache.s.title, 'latest')
    } else {
      assert.equal(env.writes.length, 1)
      assert.equal(env.api.useChatStore.getState().sessions.length, 0)
    }
  }
})

test('merge waits for latest save and refuses import when persistence fails', async () => {
  for (const fail of [false, true]) {
    const gate = deferred()
    const env = await chat({ write: async () => { await gate.promise; if (fail) throw Error('mock save failure') } })
    env.seed()
    env.api.renameSession('s', 'latest')
    await tick()
    let imported = false
    const result = env.api.mergeHistory(async () => { imported = true }, 'merge-skip').catch((error) => error)
    await tick()
    assert.equal(imported, false)
    gate.resolve()
    await result
    await tick()
    assert.equal(imported, !fail)
    assert.equal(env.api.useChatStore.getState().sessionCache.s.title, 'latest')
    if (!fail) assert.equal(env.disk.get('s').title, 'latest')
  }
})

test('deletion invalidates save blocked on attachment, before any session PUT', async () => {
  const attachment = deferred()
  const env = await chat({
    draft: { text: 'mock', files: [{ id: 'f', serverId: 'uploaded', name: 'f', size: 1, isImage: false, mimeType: 'text/plain', blob: new Blob(['mock']) }] },
    fetch: (url, init) => url === '/api/chat/files/f' && init.method === 'POST' ? attachment.promise : undefined,
  })
  env.api.useChatStore.setState({ ready: true })
  env.api.sendMessage(null)
  await tick()
  const id = env.api.useChatStore.getState().activeId
  const removal = env.api.removeSession(id)
  await tick()
  attachment.resolve(ok())
  assert.equal(await removal, true)
  assert.equal(env.writes.length, 0)
  assert.equal(env.disk.has(id), false)
})

test('replacement waits for an already-started archive operation', async () => {
  const gate = deferred()
  const env = await chat({ fetch: (url) => url.endsWith('/archive') ? gate.promise : undefined })
  env.seed()
  const archive = env.api.setSessionArchived('s', true)
  await tick()
  let staged = false
  const replacement = env.api.replaceHistory(async () => { staged = true })
  await tick()
  assert.equal(staged, false)
  gate.resolve(ok())
  assert.equal(await archive, true)
  await replacement
  assert.equal(staged, true)
})

test('attachment wait is cancelled before session PUT when history is replaced', async () => {
  const attachment = deferred()
  const env = await chat({
    draft: { text: 'mock', files: [{ id: 'f', serverId: 'uploaded', name: 'f', size: 1, isImage: false, mimeType: 'text/plain', blob: new Blob(['mock']) }] },
    fetch: (url, init) => url === '/api/chat/files/f' && init.method === 'POST' ? attachment.promise : undefined,
  })
  env.api.useChatStore.setState({ ready: true })
  assert.equal(env.api.sendMessage(null), true)
  await tick()
  const replacement = env.api.replaceHistory(async () => {})
  await tick()
  attachment.resolve(ok())
  await replacement
  assert.equal(env.writes.length, 0)
})

test('cloud continuation failure before new usage does not recount inherited usage', async () => {
  const env = await chat({ stream: async function* () { throw Error('mock early failure') } })
  env.seed(continuedSession())
  env.api.continueReply('s', 'a')
  await tick()
  assert.equal(env.records.length, 0)
  assert.equal(env.api.useChatStore.getState().sessionCache.s.messages[1].usage.input_tokens, 100)
})

test('cloud request snapshots survive upload/mode switch; actual response model and fresh IDs are billed', async () => {
  const upload = deferred()
  const env = await chat({ upload: () => upload.promise, stream: async function* () {
    yield { type: 'message_start', message: { id: 'remote', model: 'actual-cloud-model', usage: usage(12, 0) } }
    yield { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: usage(12, 4) }
    yield { type: 'message_stop' }
  } })
  env.seed(continuedSession([{ id: 'f', serverId: null, name: 'f', size: 4, isImage: false, mimeType: 'text/plain' }]))
  env.api.continueReply('s', 'a')
  await tick()
  env.setSettings({ mode: 'local', apiKey: 'new-key', maxToolRounds: 9 })
  upload.resolve('server-file')
  await tick()
  assert.equal(env.requests[0][4].mode, 'cloud')
  assert.equal(env.requests[0][0], 'mock-key')
  assert.equal(env.records[0].mode, 'cloud')
  assert.equal(env.records[0].model, 'actual-cloud-model')
  assert.equal(env.records[0].usage.input_tokens, 12)
  assert.equal(env.api.useChatStore.getState().sessionCache.s.messages[1].model, 'deepseek-flash')
  env.setSettings({ mode: 'cloud' })
  env.api.continueReply('s', 'a')
  await tick()
  assert.equal(env.records.length, 2)
  assert.notEqual(env.records[0].id, env.records[1].id)
})

test('local stream is never reported by frontend even if mode changes before finally', async () => {
  const gate = deferred()
  const env = await chat({ stream: async function* () {
    yield { type: 'message_start', message: { id: 'local', model: 'arbitrary-local-name', usage: usage() } }
    await gate.promise
    throw Error('mock local failure')
  } })
  env.setSettings({ mode: 'local' })
  env.seed(continuedSession())
  env.api.continueReply('s', 'a')
  await tick()
  env.setSettings({ mode: 'cloud' })
  gate.resolve()
  await tick()
  assert.equal(env.records.length, 0)
  assert.equal(env.requests[0][4].mode, 'local')
})

test('cloud stop after known usage records once, without counting inherited usage', async () => {
  const env = await chat({ stream: async function* (_key, _body, signal) {
    yield { type: 'message_start', message: { id: 'remote', model: 'cloud-returned', usage: usage(7, 1) } }
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  env.seed(continuedSession())
  env.api.continueReply('s', 'a')
  await tick()
  env.api.stopReply('s')
  await tick()
  assert.equal(env.records.length, 1)
  assert.equal(env.records[0].usage.input_tokens, 7)
})

test('usage HTTP failure persists sanitized event; reload retries same ID and session_id', async () => {
  const storage = memoryStorage(), bodies = []
  const first = await sandbox('src/services/usage.ts', {}, { localStorage: storage, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return new Response('', { status: 503 })
  } })
  await first.api.recordUsage({ id: 'stable', sessionId: 's', mode: 'cloud', model: 'model', usage: usage(), apiKey: 'DO-NOT-STORE', content: 'DO-NOT-STORE' })
  const saved = [...storage.values.values()].join('')
  assert.equal(saved.includes('DO-NOT-STORE'), false)
  assert.equal(JSON.parse(saved).length, 1)
  assert.equal(bodies[0].session_id, 's')
  assert.equal(Object.hasOwn(bodies[0], 'sessionId'), false)
  const second = await sandbox('src/services/usage.ts', {}, { localStorage: storage, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return ok()
  } })
  await second.api.retryPendingUsage()
  assert.deepEqual(bodies.map((item) => item.id), ['stable', 'stable'])
  assert.equal([...storage.values.values()][0], '[]')
  await second.api.recordUsage({ id: 'local', sessionId: 's', mode: 'local', model: 'local', usage: usage() })
  assert.equal(bodies.length, 2)
})

test('real client routes from explicit snapshot, not live mode, with snapshot tool limit', async () => {
  let mode = 'local'
  const calls = []
  const env = await sandbox('src/services/api/client.ts', {
    '/services/settings.ts': { useSettings: { getState: () => ({ mode, maxToolRounds: 99 }) } },
    '/i18n/index.ts': { translate: (key) => key },
  }, { __API_ORIGIN__: 'https://mock.invalid', fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response('data: {"type":"message_stop"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const body = { model: 'deepseek-flash', messages: [], system: '', thinking: { type: 'disabled' }, tools: [] }
  const consume = async (snapshot, workspaceId) => { for await (const event of env.api.streamMessage('mock', body, new AbortController().signal, 's', snapshot, workspaceId)) assert.equal(event.type, 'message_stop') }
  await consume({ mode: 'cloud', maxToolRounds: 2 }, 'cloud-workspace')
  assert.equal(calls[0].url, 'https://mock.invalid/anthropic/v1/messages')
  assert.equal(Object.hasOwn(calls[0].body, 'workspace_id'), false)
  mode = 'cloud'
  await consume({ mode: 'local', maxToolRounds: 2 }, 'local-workspace')
  assert.equal(calls[1].url, '/api/ai/messages')
  assert.equal(calls[1].body.max_tool_rounds, 2)
  assert.equal(calls[1].body.session_id, 's')
  assert.equal(calls[1].body.workspace_id, 'local-workspace')
  await consume({ mode: 'local', maxToolRounds: 2 })
  assert.equal(calls[2].body.workspace_id, null)
})

test('message version props stay referentially stable while only the streaming reply changes', async () => {
  const env = await sandbox('src/services/chat/branches.ts')
  const current = session()
  current.messages = [
    { id: 'q', role: 'user', content: 'question', files: [], createdAt: 1 },
    { id: 'a', role: 'assistant', status: 'streaming', createdAt: 1, blocks: [{ type: 'text', text: 'one' }] },
  ]
  const previous = env.api.buildMessageVersions(current, new Map())
  const next = {
    ...current,
    messages: [current.messages[0], { ...current.messages[1], blocks: [{ type: 'text', text: 'two' }] }],
  }
  const versions = env.api.buildMessageVersions(next, previous)
  assert.equal(versions, previous)
  assert.equal(versions.get('q'), previous.get('q'))
  assert.equal(versions.get('a'), previous.get('a'))
})

test('context usage throttle coalesces streaming deltas and flushes draft, stop and session changes', async () => {
  let now = 0, timerId = 0
  const timers = new Map(), estimates = []
  const env = await sandbox('src/services/contextUsageThrottle.ts', {}, {
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++timerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  })
  const throttle = env.api.createContextUsageThrottle(
    (input) => input.session.updatedAt + input.draft.length,
    {
      interval: 250,
      now: () => now,
      setTimer: (callback, delay) => {
        const id = ++timerId
        timers.set(id, { at: now + delay, callback })
        return id
      },
      clearTimer: (id) => timers.delete(id),
      onChange: (value) => estimates.push(value.used),
    }
  )
  const runDue = () => {
    const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)
    for (const [id, timer] of due) {
      timers.delete(id)
      timer.callback()
    }
  }
  let current = { ...session('s'), updatedAt: 0 }
  throttle.update({ session: current, draft: '', streaming: true, applySummary: true })
  for (now = 10; now <= 1000; now += 10) {
    current = { ...current, updatedAt: now }
    throttle.update({ session: current, draft: '', streaming: true, applySummary: true })
    runDue()
  }
  assert.deepEqual(estimates, [0, 250, 500, 750, 1000])

  now = 1010
  current = { ...current, updatedAt: now }
  throttle.update({ session: current, draft: '', streaming: true, applySummary: true })
  assert.equal(timers.size, 1)
  now = 1020
  current = { ...current, updatedAt: now }
  throttle.update({ session: current, draft: '', streaming: false, applySummary: true })
  assert.equal(timers.size, 0)
  assert.equal(estimates.at(-1), 1020)

  now = 1030
  current = { ...current, updatedAt: now }
  throttle.update({ session: current, draft: 'draft', streaming: false, applySummary: true })
  assert.equal(estimates.at(-1), 1035)
  now = 1040
  current = { ...session('next'), updatedAt: now }
  throttle.update({ session: current, draft: 'draft', streaming: true, applySummary: true })
  assert.equal(estimates.at(-1), 1045)
  now = 1050
  current = { ...current, updatedAt: now }
  throttle.update({ session: current, draft: 'new draft', streaming: true, applySummary: true })
  assert.equal(estimates.at(-1), 1059)

  now = 1060
  current = { ...current, updatedAt: now }
  throttle.update({ session: current, draft: 'new draft', streaming: true, applySummary: true })
  assert.equal(throttle.flush().used, 1069)
  assert.equal(timers.size, 0)
  now = 1070
  current = { ...current, updatedAt: now }
  throttle.update({ session: current, draft: 'new draft', streaming: true, applySummary: true })
  throttle.cancel()
  assert.equal(timers.size, 0)
  assert.deepEqual(estimates, [0, 250, 500, 750, 1000, 1020, 1035, 1045, 1059, 1069])
})

test('attachment cache deduplicates ids, retains mounted URLs and bounds idle LRU entries', async () => {
  const loads = [], created = [], revoked = []
  const env = await sandbox('src/services/attachmentCache.ts', {
    '/chat/db.ts': { loadFile: () => { throw Error('Unexpected default loader') } },
  })
  const cache = env.api.createAttachmentCache({
    limit: 2,
    load: (id) => {
      const task = deferred()
      loads.push({ id, ...task })
      return task.promise
    },
    createObjectURL: () => { const url = `blob:${created.length}`; created.push(url); return url },
    revokeObjectURL: (url) => revoked.push(url),
  })
  const firstPromise = cache.acquire('a')
  const duplicatePromise = cache.acquire('a')
  assert.equal(loads.length, 1)
  loads[0].resolve(new File(['same'], 'same-name.txt'))
  const first = await firstPromise
  const duplicate = await duplicatePromise
  assert.equal(first.url, 'blob:0')
  assert.equal(duplicate.url, first.url)
  first.release()
  first.release()
  assert.deepEqual(revoked, [])
  duplicate.release()

  const secondPromise = cache.acquire('b')
  loads[1].resolve(new Blob(['second']))
  const second = await secondPromise
  second.release()

  const retainedPromise = cache.acquire('a')
  const retained = await retainedPromise
  assert.equal(loads.filter((item) => item.id === 'a').length, 1)

  for (const [id, text] of [['c', 'third'], ['d', 'fourth']]) {
    const pending = cache.acquire(id)
    loads.at(-1).resolve(new Blob([text]))
    const handle = await pending
    handle.release()
  }
  assert.deepEqual(revoked, ['blob:1'])
  assert.equal(retained.url, 'blob:0')

  retained.release()
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
  assert.deepEqual(created, ['blob:0', 'blob:1', 'blob:2', 'blob:3'])

  const missingPromise = cache.acquire('missing')
  loads.at(-1).resolve(undefined)
  const missing = await missingPromise
  assert.equal(missing.url, null)
  missing.release()
  const missingAgainPromise = cache.acquire('missing')
  loads.at(-1).resolve(new Blob(['uploaded later']))
  const missingAgain = await missingAgainPromise
  assert.equal(missingAgain.url, 'blob:4')
  missingAgain.release()
  assert.equal(loads.filter((item) => item.id === 'missing').length, 2)

  const failedPromise = cache.acquire('retry')
  loads.at(-1).reject(Error('mock read failed'))
  await assert.rejects(failedPromise, /mock read failed/)
  const retriedPromise = cache.acquire('retry')
  loads.at(-1).resolve(new Blob(['retry']))
  const retried = await retriedPromise
  assert.equal(retried.url, 'blob:5')
  retried.release()
})

test('streaming block detection distinguishes incomplete fences and display math from closed blocks', async () => {
  const env = await sandbox('src/services/markdown/streaming.ts')
  const starts = env.api.getStreamingBlockStarts
  const position = (start, input) => ({ start: { offset: start }, end: { offset: input.length } })
  const node = (type, start, input, children) => ({
    type, position: position(start, input), ...(children ? { children } : {}),
  })
  const root = (children) => ({ type: 'root', children })

  let input = '```js\nconst x = 1'
  assert.equal(starts(root([node('code', 0, input)]), input).code, 0)
  input += '\n```'
  assert.equal(starts(root([node('code', 0, input)]), input).code, null)
  input = '~~~\nx\n~~'
  assert.equal(starts(root([node('code', 0, input)]), input).code, 0)
  input = '~~~\nx\n~~~~'
  assert.equal(starts(root([node('code', 0, input)]), input).code, null)

  input = '$$\n'
  assert.equal(starts(root([node('math', 0, input)]), input).math, 0)
  input = 'before\n\n$$\nx'
  assert.equal(starts(root([node('math', 8, input)]), input).math, 8)
  input += '\n$$'
  assert.equal(starts(root([node('math', 8, input)]), input).math, null)
  input = 'prefix\n```\nx'
  const nested = root([node('list', 0, input, [node('code', 7, input)])])
  assert.equal(starts(nested, input).code, 7)
})

// Hook harness executes actual component logic; JSX rendering is deliberately excluded.
function hooks() {
  let cursor = 0
  const cells = [], effects = [], pending = []
  return {
    begin: () => { cursor = 0 },
    runEffects: () => { for (const run of pending.splice(0)) run() },
    react: {
      useState(initial) {
        const i = cursor++
        if (!(i in cells)) cells[i] = initial
        return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }]
      },
      useRef(initial) {
        const i = cursor++
        if (!(i in cells)) cells[i] = { current: initial }
        return cells[i]
      },
      useEffect(fn, deps) {
        const i = cursor++, previous = effects[i]
        if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
          effects[i] = { deps }
          pending.push(() => { previous?.cleanup?.(); effects[i].cleanup = fn() })
        }
      },
    },
  }
}

test('Markdown throttle uses the latest streaming text and returns the complete final render immediately', async () => {
  const h = hooks()
  let now = 0, timerId = 0
  const timers = new Map()
  const env = await sandbox('src/components/markdown/useThrottleMarkdownRender.ts', {
    react: h.react,
  }, {
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++timerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  })
  const render = (content, loading) => {
    h.begin()
    const output = env.api.useThrottleMarkdownRender(content, loading)
    h.runEffects()
    return output
  }
  const runDue = () => {
    const due = [...timers].filter(([, timer]) => timer.at <= now)
    for (const [id, timer] of due) {
      timers.delete(id)
      timer.callback()
    }
  }

  assert.equal(render('a', true), 'a')
  now = 10
  assert.equal(render('ab', true), 'a')
  now = 120
  runDue()
  assert.equal(render('ab', true), 'ab')
  now = 130
  assert.equal(render('abc', true), 'ab')
  now = 200
  assert.equal(render('abcd', true), 'ab')
  now = 240
  runDue()
  assert.equal(render('abcd', true), 'abcd')
  now = 241
  assert.equal(render('final\n```', false), 'final\n```')
  assert.equal(timers.size, 0)
})

const panelStubs = (h) => ({
  react: h.react,
  clsx: { default: () => '' },
  '/base/Button.ts': { Button() {} }, '/base/Select.ts': { Select() {} },
  '/base/Modal.ts': { Modal() {} },
  '/base/icons.ts': { IconEditOutline16() {}, IconTrashOutline16() {} },
  '/base/toastState.ts': { showToast() {} },
  '/i18n/index.ts': { useTranslate: () => (key) => key },
  'Settings.module.css': { default: {} },
})

test('usage panel rejects stale success and failure, including refresh after range switch', async () => {
  const h = hooks(), requests = []
  const env = await sandbox('src/components/settings/UsageSettingsPanel.tsx', {
    ...panelStubs(h),
    '/services/usage.ts': {
      loadUsageSummary: (days) => { const task = deferred(); requests.push({ days, ...task }); return task.promise },
      clearUsage: async () => {}, saveUsagePricing: async (value) => value,
    },
  }, {}, (source, name) => name.endsWith('UsageSettingsPanel.tsx')
    ? source.slice(0, source.indexOf('  const price =')) + '\n return { load, summary, error, draft, changeRange: (range: number) => { currentRange.current = range; loadSequence.current += 1; setDays(range) } }\n}'
    : source)
  const render = () => { h.begin(); const result = env.api.UsageSettingsPanel(); h.runEffects(); return result }
  let panel = render()
  panel.changeRange(7)
  panel = render()
  requests[1].resolve({ days: 7, pricing: { input: 7 } })
  await tick()
  requests[0].resolve({ days: 30, pricing: { input: 30 } })
  await tick()
  panel = render()
  assert.equal(panel.summary.days, 7)
  assert.equal(panel.draft.input, 7)
  const old = panel.load(7)
  panel.changeRange(90)
  panel = render()
  requests[3].resolve({ days: 90, pricing: { input: 90 } })
  await tick()
  requests[2].reject(Error('stale error'))
  await old
  panel = render()
  assert.equal(panel.summary.days, 90)
  assert.equal(panel.error, '')
  await panel.load(7)
  assert.equal(requests.length, 4)
})

test('prompt panel disables overlapping writes and survives old failure before newer save', async () => {
  const h = hooks(), writes = []
  const initial = { cards: [{ id: 'a', text: 'one', name: 'A' }, { id: 'b', text: 'two', name: 'B' }], active: 'a' }
  const env = await sandbox('src/components/settings/PromptsSettingsPanel.tsx', {
    ...panelStubs(h),
    '/services/settings.ts': { useSettings: (select) => select({ mode: 'local' }) },
    '/services/prompts.ts': {
      loadPrompts: async () => initial,
      savePrompts: (value) => { const task = deferred(); writes.push({ value, ...task }); return task.promise },
    },
  }, {}, (source, name) => name.endsWith('PromptsSettingsPanel.tsx')
    ? source.slice(0, source.indexOf('  if (!local) {', source.indexOf('  const remove ='))) + '\n return { persist, state, busy }\n}'
    : source)
  const render = () => { h.begin(); const result = env.api.PromptsSettingsPanel(); h.runEffects(); return result }
  render()
  await tick()
  let panel = render()
  const old = panel.persist({ ...initial, active: 'b' })
  const ignored = panel.persist({ ...initial, active: '' })
  await tick()
  assert.equal(writes.length, 1)
  assert.equal(render().busy, true)
  writes[0].reject(Error('old failed'))
  await Promise.all([old, ignored])
  panel = render()
  assert.equal(panel.state.active, 'a')
  const latest = panel.persist({ ...initial, active: '' })
  await tick()
  writes[1].resolve(writes[1].value)
  await latest
  assert.equal(render().state.active, '')
})

test('prompt mode switch waits for server write and old completion cannot unlock new load', async () => {
  const h = hooks(), writes = [], loads = []
  let mode = 'local'
  let disk = { cards: [{ id: 'a', text: 'one', name: 'A' }], active: 'a' }
  const env = await sandbox('src/components/settings/PromptsSettingsPanel.tsx', {
    ...panelStubs(h),
    '/services/settings.ts': { useSettings: (select) => select({ mode }) },
    '/services/prompts.ts': {
      loadPrompts: () => { const task = deferred(); loads.push(task); return task.promise },
      savePrompts: async (value) => {
        const task = deferred(); writes.push(task); await task.promise; disk = value; return value
      },
    },
  }, {}, (source, name) => name.endsWith('PromptsSettingsPanel.tsx')
    ? source.slice(0, source.indexOf('  if (!local) {', source.indexOf('  const remove ='))) + '\n return { persist, state, busy }\n}'
    : source)
  const render = () => { h.begin(); const result = env.api.PromptsSettingsPanel(); h.runEffects(); return result }
  render()
  await tick()
  loads[0].resolve(disk)
  await tick()
  const old = render().persist({ ...disk, active: '' })
  await tick()
  mode = 'cloud'; render()
  mode = 'local'; render()
  await tick()
  assert.equal(loads.length, 1)
  writes[0].resolve()
  await old
  await tick()
  assert.equal(loads.length, 2)
  assert.equal(render().busy, true)
  await render().persist({ ...disk, active: 'a' })
  assert.equal(writes.length, 1)
  loads[1].resolve(disk)
  await tick()
  assert.equal(render().state.active, '')
  const next = render().persist({ ...disk, active: 'a' })
  await tick()
  writes[1].resolve()
  await next
  assert.equal(disk.active, 'a')
  assert.equal(render().state.active, 'a')
})
