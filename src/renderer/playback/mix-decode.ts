/**
 * De-duplicated PCM decode for the export mixdown's short-clip path.
 *
 * A rough cut splits one recording into many spine clips that all share a
 * single assetId. Decoding per-clip fires one ensurePcm + decodeAudioData per
 * clip, so for a cold asset that is N concurrent ensurePcm calls — and
 * ensurePcm's check-then-write cache (main/jobs/media-derivatives.ts) then
 * races N ffmpeg processes onto the same cache/pcm/<id>.wav. A clip whose
 * write finishes first fetches the file while another clip's ffmpeg is still
 * rewriting it, reads a torn wav, and decodeAudioData rejects with "Unable to
 * decode audio data" (the >=N-clip export failure). Decoding each DISTINCT
 * asset exactly once removes the duplicate concurrent writes (and the N-fold
 * memory), matching renderMixdownChunks' `decoded` map and the live graph's
 * per-asset buffer memo.
 */
export async function decodeAssetsOnce(
  assetIds: Iterable<string>,
  loadBuffer: (assetId: string) => Promise<AudioBuffer | null>
): Promise<Map<string, AudioBuffer | null>> {
  const unique = [...new Set(assetIds)]
  const buffers = await Promise.all(unique.map((assetId) => loadBuffer(assetId)))
  const decoded = new Map<string, AudioBuffer | null>()
  unique.forEach((assetId, index) => decoded.set(assetId, buffers[index]))
  return decoded
}
