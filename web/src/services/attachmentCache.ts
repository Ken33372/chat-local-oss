import { loadFile } from './chat/db.js'

type CachedFile = { url: string; refs: number }
export type AttachmentHandle = { url: string | null; release: () => void }
type Options = {
  limit?: number
  load?: (id: string) => Promise<Blob | undefined>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

/** 按 file_id 共享原件地址；正在使用的地址不淘汰，空闲缓存按 LRU 释放。 */
export const createAttachmentCache = ({
  limit = 24,
  load = loadFile,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
}: Options = {}) => {
  const maxEntries = Math.max(1, Math.floor(limit))
  const entries = new Map<string, CachedFile>()
  const retained = new Map<string, CachedFile>()
  const inFlight = new Map<string, Promise<string | null>>()

  const prune = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      const evicted = entries.get(oldest)
      entries.delete(oldest)
      if (evicted) {
        revokeObjectURL(evicted.url)
      }
    }
  }

  const retain = (id: string, url: string): AttachmentHandle => {
    const cached = retained.get(id) ?? entries.get(id)
    if (!cached || cached.url !== url) {
      throw new Error(`Attachment cache entry changed while loading: ${id}`)
    }
    entries.delete(id)
    retained.set(id, cached)
    cached.refs += 1
    let released = false
    return {
      url,
      release: () => {
        if (released) {
          return
        }
        released = true
        cached.refs -= 1
        if (cached.refs === 0 && retained.get(id) === cached) {
          retained.delete(id)
          entries.delete(id)
          entries.set(id, cached)
          prune()
        }
      },
    }
  }

  const acquire = (id: string): Promise<AttachmentHandle> => {
    const inUse = retained.get(id)
    if (inUse) {
      return Promise.resolve(retain(id, inUse.url))
    }
    const cached = entries.get(id)
    if (cached) {
      return Promise.resolve(retain(id, cached.url))
    }
    const pending = inFlight.get(id)
    if (pending) {
      return pending.then((url) =>
        url === null ? { url: null, release: () => {} } : retain(id, url)
      )
    }
    const task = load(id)
      .then((blob) => {
        if (!blob) {
          return null
        }
        const url = createObjectURL(blob)
        retained.set(id, { url, refs: 0 })
        return url
      })
      .finally(() => {
        inFlight.delete(id)
      })
    inFlight.set(id, task)
    return task.then((url) =>
      url === null ? { url: null, release: () => {} } : retain(id, url)
    )
  }

  return { acquire }
}

export const attachmentCache = createAttachmentCache()
