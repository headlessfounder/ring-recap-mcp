import { healthTool } from './health.js'
import { listCamerasTool } from './list_cameras.js'
import { syncDayTool } from './sync_day.js'
import type { ToolDef } from './types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDef<any>[] = [listCamerasTool, syncDayTool, healthTool]
