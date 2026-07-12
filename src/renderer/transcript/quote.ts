import type { SequenceWord } from './projection'

/**
 * Quote matching over the projected transcript — the agent's handle for
 * text-based editing ("cut the part where I say …"). Case and punctuation
 * insensitive; every occurrence is returned so ambiguity can be surfaced
 * instead of silently cutting the wrong take.
 */

export interface QuoteMatch {
  fromIndex: number
  toIndex: number
  fromFlicks: number
  toFlicks: number
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')

export function findQuote(words: SequenceWord[], quote: string): QuoteMatch[] {
  const needle = quote
    .split(/\s+/)
    .map(normalize)
    .filter((token) => token.length > 0)
  if (needle.length === 0) return []
  const haystack = words.map((word) => normalize(word.text))
  const matches: QuoteMatch[] = []
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    const end = start + needle.length - 1
    matches.push({
      fromIndex: start,
      toIndex: end,
      fromFlicks: words[start].seqStartFlicks,
      toFlicks: words[end].seqEndFlicks
    })
  }
  return matches
}
