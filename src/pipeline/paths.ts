import path from 'node:path'
import type { VaultPaths } from '../config.js'

export interface ClipPaths {
  rawDir: string
  mp4: string
  wav: string
  framesDir: string
  clipJson: string
  thumb: string
}

export function clipPaths(v: VaultPaths, day: string, cameraId: string, dingId: string): ClipPaths {
  const rawDir = path.join(v.raw, day, cameraId)
  return {
    rawDir,
    mp4: path.join(rawDir, `${dingId}.mp4`),
    wav: path.join(rawDir, `${dingId}.wav`),
    framesDir: path.join(v.frames, day, cameraId, dingId),
    clipJson: path.join(v.clips, day, cameraId, `${dingId}.json`),
    thumb: path.join(v.thumbs, `${dingId}.jpg`),
  }
}

export function recapPaths(v: VaultPaths, day: string): { dir: string; camera: (id: string) => string; md: string; json: string } {
  const dir = path.join(v.recaps, day)
  return {
    dir,
    camera: (id: string) => path.join(dir, `${id}.md`),
    md: path.join(dir, 'site.md'),
    json: path.join(dir, 'site.json'),
  }
}
