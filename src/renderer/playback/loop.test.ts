import { describe, expect, it } from 'vitest'
import { loadLoopPref, saveLoopPref, sequenceEndAction } from './loop'

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    }
  }
}

describe('sequenceEndAction', () => {
  it('wraps when loop is on', () => {
    expect(sequenceEndAction(true)).toBe('wrap')
  })
  it('stops when loop is off', () => {
    expect(sequenceEndAction(false)).toBe('stop')
  })
})

describe('loop pref persistence', () => {
  it('round-trips on', () => {
    const storage = fakeStorage()
    saveLoopPref(true, storage)
    expect(loadLoopPref(storage)).toBe(true)
  })
  it('removes the key when turned off (default state stores nothing)', () => {
    const storage = fakeStorage()
    saveLoopPref(true, storage)
    saveLoopPref(false, storage)
    expect(storage.getItem('magnetic.playback.v1')).toBeNull()
    expect(loadLoopPref(storage)).toBe(false)
  })
  it('defaults to false on missing or malformed payloads', () => {
    expect(loadLoopPref(fakeStorage())).toBe(false)
    expect(loadLoopPref(fakeStorage({ 'magnetic.playback.v1': 'not json{' }))).toBe(false)
    expect(loadLoopPref(fakeStorage({ 'magnetic.playback.v1': '{"loop":"yes"}' }))).toBe(false)
  })
})
