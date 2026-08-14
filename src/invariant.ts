/** Package-owned mount message invariants. @module dsh-file-mount/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-session/types'

const PACKAGE_NAME = 'dsh-file-mount'

/** Cordis companion plugin name. */
export const name = 'file-mount-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Narrow-and-fail: explicit return type keeps control-flow narrowing working. */
function recordOrFail(value: unknown, fail: (message: string) => never, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(label)
  return value
}

function isValidSegment(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { start, end } = value
  return isPositiveInteger(start) && isPositiveInteger(end) && end >= start
}

function isValidSegmentList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(isValidSegment)
}

/** Validate one plugin-injected mount message's structured source. */
function validateMountSource(source: Record<string, unknown>, fail: (message: string) => never): void {
  if (source['form'] !== 'notice') fail('file-mount source form must be "notice"')
  if (!isNonEmptyString(source['summary'])) fail('file-mount source summary must be a non-empty string')
  if (!isNonEmptyString(source['path'])) fail('file-mount source path must be a non-empty string')
  if (!isNonEmptyString(source['hash'])) fail('file-mount source hash must be a non-empty string')
  if (!isPositiveInteger(source['totalLines'])) fail('file-mount source totalLines must be a positive safe integer')
  if (source['mountKind'] !== 'new' && source['mountKind'] !== 'increment' && source['mountKind'] !== 'remount' && source['mountKind'] !== 'dedup') {
    fail('file-mount source mountKind must be new, increment, remount, or dedup')
  }
  if (!isNonNegativeInteger(source['savedTokens'])) fail('file-mount source savedTokens must be a non-negative safe integer')
  if (!isValidSegmentList(source['mounted'])) fail('file-mount source mounted must be a non-empty valid segment list')
  if (!Array.isArray(source['added']) || !source['added'].every(isValidSegment)) fail('file-mount source added must be a valid segment list (may be empty)')
}

/** Install checks over the injected mount message stream. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = args[1] as { type: string; data: unknown } | undefined
    if (event === undefined || event.type !== 'user/message') return
    const data = isRecord(event.data) ? event.data : undefined
    if (data === undefined) return
    const source = recordOrFail(data['source'], fail, 'user/message source must be an object')
    if (source['kind'] !== 'plugin' || source['plugin'] !== 'file-mount') return
    validateMountSource(source, fail)
  }, { global: true })
}

/**
 * Register the file-mount invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))