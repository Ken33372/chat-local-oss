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
  id, title: 'before', createdAt: 1, updatedAt: 1,
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
  const consume = async (snapshot) => { for await (const event of env.api.streamMessage('mock', body, new AbortController().signal, 's', snapshot)) assert.equal(event.type, 'message_stop') }
  await consume({ mode: 'cloud', maxToolRounds: 2 })
  assert.equal(calls[0].url, 'https://mock.invalid/anthropic/v1/messages')
  mode = 'cloud'
  await consume({ mode: 'local', maxToolRounds: 2 })
  assert.equal(calls[1].url, '/api/ai/messages')
  assert.equal(calls[1].body.max_tool_rounds, 2)
  assert.equal(calls[1].body.session_id, 's')
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
