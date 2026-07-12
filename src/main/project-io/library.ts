import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import type { Event, Library, MediaAsset, Project, Rating, Sequence } from '../../shared/types'
import { rippleDelete } from '../../shared/timeline/ops'
import { readJson, writeJsonAtomic } from './atomic'

interface LibraryJson {
  id: string
  name: string
  assets: Record<string, MediaAsset>
}

interface SettingsJson {
  lastLibraryPath?: string
  autoTranscribe?: boolean
  /** Anthropic API key for the Copilot advisor. Stored here (userData), never in the renderer's localStorage, never logged. */
  anthropicApiKey?: string
}

export function getAutoTranscribe(): boolean {
  return readSettings().autoTranscribe ?? true
}

export function setAutoTranscribe(enabled: boolean): void {
  writeSettings({ ...readSettings(), autoTranscribe: enabled })
}

export function getAnthropicApiKey(): string | null {
  return readSettings().anthropicApiKey ?? null
}

export function setAnthropicApiKey(key: string | null): void {
  const settings = { ...readSettings() }
  if (key === null || key === '') delete settings.anthropicApiKey
  else settings.anthropicApiKey = key
  writeSettings(settings)
}

const AUTOSAVE_DELAY_MS = 500

/**
 * A library is a folder `<name>.mglib/` containing library.json (id/name/assets),
 * events/*.json, projects/*.json, media/ (imported copies) and cache/
 * (filmstrips, peaks, …). All JSON writes are atomic (temp + rename).
 */
export class LibraryStore {
  readonly root: string
  private data: LibraryJson
  private events: Event[]
  private projects: Project[]
  private saveTimer: NodeJS.Timeout | null = null
  private listeners = new Set<() => void>()

  private constructor(root: string, data: LibraryJson, events: Event[], projects: Project[]) {
    this.root = root
    this.data = data
    this.events = events
    this.projects = projects
  }

  static open(root: string): LibraryStore {
    if (existsSync(join(root, 'library.json'))) {
      const data = readJson<LibraryJson>(join(root, 'library.json'))
      const events = loadDir<Event>(join(root, 'events'))
      const projects = loadDir<Project>(join(root, 'projects'))
      return new LibraryStore(root, data, events, projects)
    }
    return LibraryStore.create(root)
  }

  static create(root: string): LibraryStore {
    for (const dir of ['', 'events', 'projects', 'media', 'cache']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    const name = libraryNameFromPath(root)
    const data: LibraryJson = { id: randomUUID(), name, assets: {} }
    const defaultEvent: Event = {
      id: randomUUID(),
      name: 'Imported Media',
      assetIds: [],
      projectIds: []
    }
    const store = new LibraryStore(root, data, [defaultEvent], [])
    store.saveNow()
    return store
  }

  /** Resolve which library to open: env override > last-used > default. */
  static resolveStartupPath(): string {
    const envPath = process.env.MAGNETIC_LIBRARY_PATH
    if (envPath !== undefined && envPath !== '') return envPath
    const settings = readSettings()
    if (settings.lastLibraryPath !== undefined && existsSync(settings.lastLibraryPath)) {
      return settings.lastLibraryPath
    }
    return join(homedir(), 'Videos', 'Magnetic.mglib')
  }

  rememberAsLastUsed(): void {
    writeSettings({ ...readSettings(), lastLibraryPath: this.root })
  }

  get library(): Library {
    return {
      id: this.data.id,
      name: this.data.name,
      path: this.root,
      events: this.events
    }
  }

  get assets(): Record<string, MediaAsset> {
    return this.data.assets
  }

  get defaultEvent(): Event {
    return this.events[0]
  }

  mediaDir(): string {
    return join(this.root, 'media')
  }

  cacheDir(): string {
    return join(this.root, 'cache')
  }

  addAsset(asset: MediaAsset, eventId?: string): void {
    this.data.assets[asset.id] = asset
    const target = this.events.find((event) => event.id === eventId) ?? this.defaultEvent
    if (!target.assetIds.includes(asset.id)) target.assetIds.push(asset.id)
    this.scheduleSave()
    this.notify()
  }

  updateAsset(assetId: string, patch: Partial<MediaAsset>): void {
    const asset = this.data.assets[assetId]
    if (asset === undefined) throw new Error(`unknown asset: ${assetId}`)
    Object.assign(asset, patch)
    this.scheduleSave()
    this.notify()
  }

  setRating(assetId: string, rating: Rating): void {
    this.updateAsset(assetId, { rating })
  }

  deleteAsset(assetId: string): void {
    const asset = this.data.assets[assetId]
    if (asset === undefined) throw new Error(`unknown asset: ${assetId}`)

    delete this.data.assets[assetId]
    this.events = this.events.map((event) => ({
      ...event,
      assetIds: event.assetIds.filter((id) => id !== assetId)
    }))
    this.projects = this.projects.map((project) => ({
      ...project,
      sequence: deleteAssetUses(project.sequence, assetId)
    }))
    this.scheduleSave()
    this.notify()
    // Last and best-effort: a locked media file (Windows EBUSY/EPERM while an
    // ffmpeg job still reads it) must not abort the logical delete above.
    this.deleteAssetFiles(asset)
  }

  /** The library's single default project, created (and persisted) on first use. */
  getOrCreateDefaultProject(): Project {
    if (this.projects.length === 0) {
      const project: Project = {
        id: randomUUID(),
        name: 'Untitled Project',
        sequence: { id: randomUUID(), fps: { num: 30, den: 1 }, spine: [], connected: [] }
      }
      this.projects.push(project)
      if (!this.defaultEvent.projectIds.includes(project.id)) {
        this.defaultEvent.projectIds.push(project.id)
      }
      this.scheduleSave()
    }
    return this.projects[0]
  }

  saveProjectSequence(projectId: string, sequence: Sequence): void {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (project === undefined) throw new Error(`unknown project: ${projectId}`)
    project.sequence = sequence
    this.scheduleSave()
  }

  /** Subscribe to any library mutation. Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), AUTOSAVE_DELAY_MS)
  }

  saveNow(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    writeJsonAtomic(join(this.root, 'library.json'), this.data)
    for (const event of this.events) {
      writeJsonAtomic(join(this.root, 'events', `${event.id}.json`), event)
    }
    for (const project of this.projects) {
      writeJsonAtomic(join(this.root, 'projects', `${project.id}.json`), project)
    }
  }

  private deleteAssetFiles(asset: MediaAsset): void {
    const relPaths = [
      asset.libraryRelPath,
      asset.filmstrip?.stripPath,
      asset.waveform?.peaksPath,
      asset.envelope?.envelopePath,
      asset.proxyPath,
      asset.transcriptPath,
      join('cache', 'pcm', `${asset.id}.wav`),
      join('cache', 'proxy', `${asset.id}.mp4`)
    ].filter((path): path is string => path !== undefined)

    for (const relPath of relPaths) {
      try {
        rmSync(join(this.root, relPath), { force: true })
      } catch (error) {
        console.error(`delete asset: could not remove ${relPath}:`, error)
      }
    }
  }
}

function deleteAssetUses(sequence: Sequence, assetId: string): Sequence {
  const spineIds = sequence.spine
    .filter((item) => item.kind === 'clip' && item.assetId === assetId)
    .map((item) => item.id)
  const withoutSpine =
    spineIds.length === 0 ? sequence : rippleDelete(sequence, { ids: spineIds }).next
  const connected = withoutSpine.connected.filter((clip) => clip.assetId !== assetId)
  return connected.length === withoutSpine.connected.length
    ? withoutSpine
    : { ...withoutSpine, connected }
}

function loadDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.tmp-'))
    .map((name) => readJson<T>(join(dir, name)))
}

function libraryNameFromPath(root: string): string {
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? 'Library'
  return base.replace(/\.mglib$/i, '')
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readSettings(): SettingsJson {
  try {
    return readJson<SettingsJson>(settingsPath())
  } catch {
    return {}
  }
}

function writeSettings(settings: SettingsJson): void {
  writeJsonAtomic(settingsPath(), settings)
}
