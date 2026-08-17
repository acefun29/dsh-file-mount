/** Mounted-files dashboard: progress bars, search, sort, net savings + a rough
 * CNY figure (plan items 16 + 17), matching the DSH tab styling. */

import { useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FRESHNESS_TIERS,
  MountFold,
  freshnessLevel,
  nearestTier,
  tierOf,
  type FreshnessSettingsApi,
  type FreshnessTierId,
} from './mounted-files.ts'
import { formatRange } from '../render.ts'
import css from './MountedFilesView.module.css'

export type MountedFilesViewProps = ConvViewProps & PropsLocale<'file-mount'> & {
  /** Host settings face for the tier picker (absent in environments without a connection). */
  api?: FreshnessSettingsApi
}

/** Rough conversion for the savings figure: yuan per one million tokens. */
const CNY_PER_MILLION_TOKENS = 1

function mountedLines(mount: { ranges: { start: number; end: number }[] }): number {
  return mount.ranges.reduce((n, range) => n + (range.end - range.start + 1), 0)
}

/** Map a freshness level to its locale key (typed lookup). */
const LEVEL_KEYS = {
  fresh: 'freshness.fresh',
  ok: 'freshness.ok',
  warn: 'freshness.warn',
  expired: 'freshness.expired',
  unknown: 'freshness.unknown',
} as const

function levelKey(level: keyof typeof LEVEL_KEYS) {
  return LEVEL_KEYS[level]
}

/**
 * Dashboard over the conversation snapshot: fold the injected mount messages
 * through a persistent {@link MountFold} (one per view instance), so mounts
 * whose messages scroll out of the client's paginated history window stay on
 * the dashboard, then render one row per file with a progress bar, search,
 * and sorting. The fold resets when the conversation (sessionId) changes.
 * @param props - slot standard kit (useSession) plus the view locale seat.
 * @returns the mounted-files dashboard, or the localized empty hint.
 */
export function MountedFilesView({ useSession, t, api }: MountedFilesViewProps) {
  const sessionId = useSession((snapshot) => snapshot.sessionId)
  const nodes = useSession((snapshot) => snapshot.nodes)
  const foldRef = useRef<MountFold | undefined>(undefined)
  const mounts = useMemo(() => {
    const fold = foldRef.current ?? (foldRef.current = new MountFold())
    return fold.fold(sessionId, nodes)
  }, [sessionId, nodes])
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'net' | 'path'>('net')
  const [showHelp, setShowHelp] = useState(false)
  // Freshness segment rows are expanded by default; clicking collapses one file.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  // User-chosen freshness tier (null = follow the threshold the host stamped).
  const [tierId, setTierId] = useState<FreshnessTierId | null>(null)
  // The threshold the host stamped on the latest mount source (follows the
  // host settings, which the picker itself updates through the api).
  const foldedThreshold = mounts[0]?.freshnessThreshold ?? 0.6
  const effectiveThreshold = tierId === null ? foldedThreshold : tierOf(tierId)

  const { savedTotal, spentTotal, netTotal } = useMemo(() => {
    let saved = 0
    let spent = 0
    for (const mount of mounts) {
      saved += mount.savedTokens
      spent += mount.spentTokens
    }
    return { savedTotal: saved, spentTotal: spent, netTotal: saved - spent }
  }, [mounts])
  if (mounts.length === 0) {
    return (
      <div className={css.root}>
        <div className={css.empty} data-mount-empty>{t('list.empty')}</div>
      </div>
    )
  }

  const filter = query.trim().toLowerCase()
  const visible = mounts
    .filter((mount) => filter.length === 0 || mount.path.toLowerCase().includes(filter))
    .sort((a, b) => sortBy === 'path'
      ? a.path.localeCompare(b.path)
      : (b.savedTokens - b.spentTokens) - (a.savedTokens - a.spentTokens))
  const cny = (Math.max(0, netTotal) / 1_000_000) * CNY_PER_MILLION_TOKENS

  return (
    <div className={css.root} data-mount-list>
      <div
        className={css.summary + (netTotal > 0 ? ' ' + css.summaryPositive : ' ' + css.summaryNeutral)}
        data-mount-summary
        title={`累计去重节省 ${savedTotal} tokens，状态通知开销 ${spentTotal} tokens`}
      >
        <span data-mount-net-total>{t('summary.netTotal').replace('{n}', String(netTotal))}</span>
        <span className={css.cny} data-mount-cny>{t('summary.cny').replace('{n}', cny.toFixed(2))}</span>
      </div>
      <div className={css.toolbar}>
        <input
          className={css.search}
          data-mount-search
          type="search"
          placeholder={t('list.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className={css.sort}
          data-mount-sort
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as 'net' | 'path')}
        >
          <option value="net">{t('list.sortNet')}</option>
          <option value="path">{t('list.sortPath')}</option>
        </select>
        <div className={css.tierControl}>
          <select
            className={css.sort}
            data-mount-tier
            title={t('tier.hint')}
            aria-label={t('tier.label')}
            value={tierId ?? nearestTier(foldedThreshold)}
            onChange={(event) => {
              const id = event.target.value as FreshnessTierId
              setTierId(id)
              // Push to the host: the settings namespace update persists and
              // re-stamps future mount sources; the local override already
              // re-renders this view immediately.
              api?.update({ ns: 'file-mount', patch: { freshnessThreshold: tierOf(id) } }).catch(() => {})
            }}
          >
            {FRESHNESS_TIERS.map((tier) => (
              <option key={tier.id} value={tier.id}>{t(`tier.${tier.id}`)} ({tier.threshold})</option>
            ))}
          </select>
          <button
            type="button"
            className={css.tierHelp + (showHelp ? ' ' + css.tierHelpActive : '')}
            onClick={() => setShowHelp(!showHelp)}
            title={t('tier.hint')}
            aria-label={t('tier.label')}
          >
            ?
          </button>
        </div>
      </div>
      {showHelp && (
        <div className={css.helpCard} data-mount-help-card>
          <div className={css.helpHeader}>
            <span>{t('help.title')}</span>
            <button type="button" className={css.helpClose} onClick={() => setShowHelp(false)}>{t('help.close')}</button>
          </div>
          <div className={css.helpSection}>
            <div className={css.helpSectionTitle}>• {t('help.modelTitle')}</div>
            <div className={css.helpSectionDesc}>{t('help.modelDesc')}</div>
          </div>
          <div className={css.helpSection}>
            <div className={css.helpSectionTitle}>• {t('help.savingsTitle')}</div>
            <div className={css.helpSectionDesc}>{t('help.savingsDesc')}</div>
          </div>
        </div>
      )}
      {visible.map((mount) => {
        const lines = mountedLines(mount)
        const pct = mount.totalLines > 0 ? Math.min(100, Math.round((lines / mount.totalLines) * 100)) : 0
        const isCollapsed = collapsed.has(mount.path)
        const levels = mount.ranges.map((seg) => freshnessLevel(seg.born, mount.contextL, effectiveThreshold, seg.tokens, { expired: seg.expired }))
        const worst = levels.includes('expired') ? 'expired' : levels.includes('warn') ? 'warn' : levels.includes('ok') ? 'ok' : 'fresh'
        const netDiff = mount.savedTokens - mount.spentTokens
        return (
          <div key={mount.path} className={css.row} data-mount-row data-mount-kind={mount.mountKind}>
            <div
              className={css.pathRow}
              role="button"
              tabIndex={0}
              onClick={() => {
                const next = new Set(collapsed)
                if (isCollapsed) next.delete(mount.path)
                else next.add(mount.path)
                setCollapsed(next)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  const next = new Set(collapsed)
                  if (isCollapsed) next.delete(mount.path)
                  else next.add(mount.path)
                  setCollapsed(next)
                }
              }}
            >
              <button
                type="button"
                className={css.expand}
                data-mount-expand
                aria-expanded={!isCollapsed}
                onClick={(event) => {
                  event.stopPropagation()
                  const next = new Set(collapsed)
                  if (isCollapsed) next.delete(mount.path)
                  else next.add(mount.path)
                  setCollapsed(next)
                }}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
              <div className={css.path} title={mount.path}>{mount.path}</div>
              <span className={css.freshnessDot + ' ' + (css['freshnessDot_' + worst] ?? '')} data-mount-file-freshness={worst} title={t(levelKey(worst))} />
            </div>
            <div className={css.progress} data-mount-progress role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={css.progressFill} style={{ width: `${pct}%` }} />
            </div>
            <div className={css.meta}>
              <span className={css.badge + ' ' + (css['badge_' + mount.mountKind] ?? '')} data-mount-badge>{t(`kind.${mount.mountKind}`)}</span>
              <span className={css.ranges} data-mount-ranges>
                {mount.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}
              </span>
              <span className={css.hash} data-mount-hash>{t('list.hash')} {mount.hash.slice(0, 8)}</span>
              <span className={css.lines} data-mount-lines>{lines}/{mount.totalLines} {t('list.lines')}</span>
              <span className={css.saved + (netDiff > 0 ? ' ' + css.savedPositive : '')} data-mount-net>
                {t('row.net').replace('{n}', String(netDiff))}
              </span>
              {mount.mountKind === 'remount' && (
                <span className={css.changed} data-mount-changed>{t('row.changed')}</span>
              )}
            </div>
            {!isCollapsed && mount.ranges.length > 0 && (
              <div className={css.segmentsList}>
                {mount.ranges.map((seg, i) => {
                  const level = freshnessLevel(seg.born, mount.contextL, effectiveThreshold, seg.tokens, { expired: seg.expired })
                  return (
                    <div key={i} className={css.segment} data-mount-segment data-freshness={level}>
                      <span className={css.segmentBar + ' ' + (css['segmentBar_' + level] ?? '')} />
                      <span className={css.segmentRange}>{formatRange(seg.start, seg.end)}</span>
                      <span className={css.segmentLevel}>{t(levelKey(level))}</span>
                      {seg.expired > 0 && (
                        <span className={css.expiredBadge} data-mount-expired-badge title={t('freshness.expiredTitle')}>
                          {t('freshness.expiredBadge').replace('{n}', String(seg.expired))}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}