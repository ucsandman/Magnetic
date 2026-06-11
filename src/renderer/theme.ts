/**
 * Magnetic dark theme tokens (FCP-style). The same values are mirrored as CSS
 * custom properties in styles/global.css — keep both in sync.
 */
export const theme = {
  colors: {
    appBg: '#161617',
    panelBg: '#1d1d1f',
    panelAlt: '#28282b',
    border: '#3a3a3c',
    accent: '#0a84ff',
    text: '#f5f5f7',
    textDim: '#98989d'
  },
  /** UI type scale in px — FCP uses small, dense UI type. */
  fontSize: {
    small: 11,
    base: 12,
    large: 13
  }
} as const

export type Theme = typeof theme
