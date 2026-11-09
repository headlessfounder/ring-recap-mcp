import type { AppContext } from '../context.js'
import { errMsg, log } from '../util/log.js'
import { mapLimit } from '../util/retry.js'
import { defineTool } from './types.js'

export interface CameraListing {
  id: string
  name: string
  online: boolean
  lastEventAt: string | null
  model: string
}

export async function listCameras(ctx: AppContext): Promise<CameraListing[]> {
  const cams = await ctx.ring.cameras({ fresh: true })
  ctx.ledger.setKv('cameras', { at: Date.now(), cameras: cams })
  const last = await mapLimit(cams, 4, (c) => ctx.ring.lastEventAt(c.id))
  return cams
    .map((c, i) => {
      const r = last[i]
      let t: number | null = r.ok ? r.value : null
      if (!r.ok) {
        log.warn({ camera: c.name, err: errMsg(r.error) }, 'lastEventAt failed; using ledger')
        const row = ctx.ledger.db
          .prepare('SELECT MAX(created_at) AS t FROM clips WHERE camera_id = ?')
          .get(c.id) as { t: number | null }
        t = row?.t ?? null
      }
      return { id: c.id, name: c.name, online: c.online, lastEventAt: t ? new Date(t).toISOString() : null, model: c.model }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const listCamerasTool = defineTool({
  name: 'list_cameras',
  title: 'List cameras',
  description:
    'Lists the Ring cameras at the configured Ring location (other locations are ignored) with id, name, online state, last event time and model.',
  inputSchema: {},
  readOnly: true,
  handler: async (ctx) => ({ json: await listCameras(ctx) }),
})
