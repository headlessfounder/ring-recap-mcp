import type { z } from 'zod'
import type { AppContext } from '../context.js'

export interface ToolOutput {
  /** structured result; rendered as pretty JSON text for MCP clients */
  json?: unknown
  /** markdown or plain text (takes the place of json in the text block when both are set) */
  text?: string
  image?: { data: string; mimeType: string }
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  inputSchema: S
  readOnly: boolean
  handler: (ctx: AppContext, args: z.infer<z.ZodObject<S>>) => Promise<ToolOutput>
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}
