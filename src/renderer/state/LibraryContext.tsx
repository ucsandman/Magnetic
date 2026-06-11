import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LibrarySnapshot } from '../../shared/types'

/** Viewer I/O marks published for timeline edit commands (E/W/Q/D source range). */
export interface MarkedRange {
  assetId: string
  inFlicks: number | null
  outFlicks: number | null
}

/** Timeline skim → viewer static frame preview. */
export interface SkimTarget {
  assetId: string
  mediaFlicks: number
}

interface LibraryContextValue {
  snapshot: LibrarySnapshot | null
  selectedIds: string[]
  setSelectedIds(ids: string[]): void
  /** Asset currently loaded in the viewer. */
  openedAssetId: string | null
  openAsset(id: string | null): void
  markedRange: MarkedRange | null
  setMarkedRange(range: MarkedRange | null): void
  skimTarget: SkimTarget | null
  setSkimTarget(target: SkimTarget | null): void
}

const LibraryContext = createContext<LibraryContextValue | null>(null)

export function LibraryProvider({ children }: { children: ReactNode }): ReactNode {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [openedAssetId, setOpenedAssetId] = useState<string | null>(null)
  const [markedRange, setMarkedRange] = useState<MarkedRange | null>(null)
  const [skimTarget, setSkimTarget] = useState<SkimTarget | null>(null)

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

  const value = useMemo(
    () => ({
      snapshot,
      selectedIds,
      setSelectedIds,
      openedAssetId,
      openAsset: setOpenedAssetId,
      markedRange,
      setMarkedRange,
      skimTarget,
      setSkimTarget
    }),
    [snapshot, selectedIds, openedAssetId, markedRange, skimTarget]
  )
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- context modules export provider + hook by design
export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext)
  if (value === null) throw new Error('useLibrary must be used inside LibraryProvider')
  return value
}
