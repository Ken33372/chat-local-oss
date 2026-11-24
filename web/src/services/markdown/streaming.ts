import type { Nodes, Root } from 'mdast'

export type StreamingBlockStarts = { code: number | null; math: number | null }

const EMPTY_STARTS: StreamingBlockStarts = { code: null, math: null }

/** 找到解析器已接收、但定界符尚未闭合的末尾代码块或显示公式。 */
export const getStreamingBlockStarts = (
  ast: Root,
  input: string
): StreamingBlockStarts => {
  const starts: StreamingBlockStarts = { ...EMPTY_STARTS }
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end === input.length) {
      const raw = input.slice(start, end)
      if (node.type === 'code') {
        const opening = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
        const marker = opening?.[1]
        if (marker) {
          const closed = raw
            .split(/\r?\n/)
            .slice(1)
            .some((line) => {
              const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
              return (
                closing !== null &&
                closing[1][0] === marker[0] &&
                closing[1].length >= marker.length
              )
            })
          if (!closed) {
            starts.code = start
          }
        }
      } else if (node.type === 'math') {
        const trimmed = raw.trimEnd()
        if (trimmed.startsWith('$$') && (trimmed.length === 2 || !trimmed.endsWith('$$'))) {
          starts.math = start
        }
      }
    }
    if ('children' in node) {
      node.children.forEach(visit)
    }
  }
  visit(ast)
  return starts
}
