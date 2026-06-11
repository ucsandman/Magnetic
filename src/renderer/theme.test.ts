import { describe, expect, it } from 'vitest'
import { theme } from './theme'

const HEX_COLOR = /^#[0-9a-f]{6}$/

describe('theme tokens', () => {
  it('defines all color tokens as 6-digit hex', () => {
    for (const [name, value] of Object.entries(theme.colors)) {
      expect(value, `color token ${name}`).toMatch(HEX_COLOR)
    }
  })

  it('uses the FCP-style accent blue', () => {
    expect(theme.colors.accent).toBe('#0a84ff')
  })

  it('keeps UI type in the dense 11-13px range', () => {
    const sizes = Object.values(theme.fontSize)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(13)
    expect(theme.fontSize.small).toBeLessThan(theme.fontSize.base)
    expect(theme.fontSize.base).toBeLessThan(theme.fontSize.large)
  })
})
