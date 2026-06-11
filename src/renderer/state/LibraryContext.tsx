import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LibrarySnapshot } from '../../shared/types'

interface LibraryContextValue {
  snapshot: LibrarySnapshot | null
  selectedIds: string[]
  setSelectedIds(ids: string[]): void
}

const LibraryContext = createContext<LibraryContextValue | null>(null)

export function LibraryProvider({ children }: { children: ReactNode }): ReactNode {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  useEffect(() => {
    let disposed = false
    window.api.getLibrary().then((snap) => {
      if (!disposed) setSnapshot(snap)
    })
    const unsubscribe = window.api.onLibraryChanged((snap) => setSnapshot(snap))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ snapshot, selectedIds, setSelectedIds }), [snapshot, selectedIds])
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- context modules export provider + hook by design
export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext)
  if (value === null) throw new Error('useLibrary must be used inside LibraryProvider')
  return value
}
