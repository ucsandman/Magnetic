/**
 * Minimal FIFO background job queue, concurrency 2. Jobs run in main but are
 * fully async (spawned ffmpeg), so the UI thread never blocks. Failures are
 * logged to the job's completion callback — they never crash the app.
 */
export interface Job {
  label: string
  run(): Promise<void>
}

export class JobQueue {
  private readonly concurrency: number
  private readonly pending: Job[] = []
  private active = 0
  private onError: (label: string, error: unknown) => void

  constructor(concurrency = 2, onError: (label: string, error: unknown) => void = () => {}) {
    this.concurrency = concurrency
    this.onError = onError
  }

  enqueue(job: Job): void {
    this.pending.push(job)
    this.pump()
  }

  get size(): number {
    return this.pending.length + this.active
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!
      this.active += 1
      job
        .run()
        .catch((error: unknown) => this.onError(job.label, error))
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }
}
