// @vitest-environment jsdom
/**
 * Component coverage: the mounted-files view renders the folded ledger and
 * the empty hint. The slot registry glue is thin (index.ts) and rides the
 * real boot smoke in the release checklist instead of a unit bench.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { MountedFilesView } from '../../src/client/MountedFilesView.tsx'
import type { FileMountKey } from '../src/client/locales.ts'
import { zh } from '../../src/client/locales.ts'

function viewProps(nodes: readonly ConversationNode[]) {
  const t = (key: FileMountKey): string => zh[key]
  return {
    // Minimal stand-in for the slot runtime share: one stable snapshot.
    useSession: (selector: (snapshot: { nodes: readonly ConversationNode[]; sessionId: string }) => unknown) =>
      selector({ nodes, sessionId: 's1' }),
    useSessions: () => undefined,
    sessionId: 's1' as never,
    t,
  }
}

describe('MountedFilesView', () => {
  it('renders the localized empty hint when nothing is mounted', () => {
    const { container } = render(<MountedFilesView {...viewProps([])} />)
    expect(container.querySelector('[data-mount-empty]')?.textContent).toBe(zh['list.empty'])
  })

  it('renders one row per mounted file with range and kind labels', () => {
    const nodes: ConversationNode[] = [
      {
        kind: 'context',
        seq: 1,
        time: 1000,
        content: [{ type: 'text', text: 'block' }],
        source: {
          kind: 'plugin',
          plugin: 'file-mount',
          form: 'notice',
          summary: 'mounted L1-50',
          path: 'src/a.ts',
          hash: 'abcdef0123456789',
          totalLines: 100,
          mounted: [{ start: 1, end: 50 }],
          added: [{ start: 1, end: 50 }],
          mountKind: 'new',
          savedTokens: 0,
        },
        provenance: { role: 'inject', label: 'file-mount' },
        form: 'notice',
      },
    ]
    const { container } = render(<MountedFilesView {...viewProps(nodes)} />)
    const summary = container.querySelector('[data-mount-summary]')?.textContent ?? ''
    expect(summary).toContain(zh['summary.netTotal'].replace('{n}', '0'))
    expect(container.querySelector('[data-mount-cny]')?.textContent).toBe(zh['summary.cny'].replace('{n}', '0.00'))
    expect(container.querySelector('[data-mount-search]')).not.toBeNull()
    expect(container.querySelector('[data-mount-sort]')).not.toBeNull()
    const rows = container.querySelectorAll('[data-mount-row]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.querySelector('[data-mount-badge]')?.textContent).toBe(zh['kind.new'])
    expect(rows[0]!.querySelector('[data-mount-ranges]')?.textContent).toBe('L1-50')
    expect(rows[0]!.querySelector('[data-mount-hash]')?.textContent).toContain('abcdef01')
    expect(rows[0]!.querySelector('[data-mount-lines]')?.textContent).toBe('50/100 ' + zh['list.lines'])
    expect(rows[0]!.querySelector('[data-mount-progress]')?.getAttribute('aria-valuenow')).toBe('50')
    expect(rows[0]!.querySelector('[data-mount-net]')?.textContent).toBe(zh['row.net'].replace('{n}', '0'))
    expect(rows[0]!.getAttribute('data-mount-kind')).toBe('new')
  })

  it('re-renders when the folded ledger changes', () => {
    const a: ConversationNode[] = []
    const b: ConversationNode[] = [
      {
        kind: 'context',
        seq: 1,
        time: 1000,
        content: [{ type: 'text', text: 'block' }],
        source: {
          kind: 'plugin',
          plugin: 'file-mount',
          form: 'notice',
          summary: 'mounted L1-4',
          path: 'src/a.ts',
          hash: 'abcdef0123456789',
          totalLines: 10,
          mounted: [{ start: 1, end: 4 }],
          added: [{ start: 1, end: 4 }],
          mountKind: 'new',
          savedTokens: 0,
        },
        provenance: { role: 'inject', label: 'file-mount' },
        form: null,
      },
    ]
    const nodes = vi.fn<() => ConversationNode[]>()
    nodes.mockReturnValue(a)
    const props = {
      useSession: (selector: (snapshot: { nodes: readonly ConversationNode[]; sessionId: string }) => unknown) =>
        selector({ nodes: nodes(), sessionId: 's1' }),
      useSessions: () => undefined,
      sessionId: 's1' as never,
      t: (key: FileMountKey): string => zh[key],
    }
    const { container, rerender } = render(<MountedFilesView {...props} />)
    expect(container.querySelector('[data-mount-empty]')).not.toBeNull()
    nodes.mockReturnValue(b)
    rerender(<MountedFilesView {...props} />)
    expect(container.querySelectorAll('[data-mount-row]')).toHaveLength(1)
    expect(container.querySelector('[data-mount-empty]')).toBeNull()
  })

  it('tier picker overrides the freshness level and pushes the threshold to the host', async () => {
    const nodes: ConversationNode[] = [
      {
        kind: 'assistant',
        seq: 1,
        time: 1000,
        turn: 1,
        step: 1,
        blocks: [],
        usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 1 },
        messageId: 'm1' as never,
      } as unknown as ConversationNode,
      {
        kind: 'context',
        seq: 2,
        time: 2000,
        content: [{ type: 'text', text: 'block' }],
        source: {
          kind: 'plugin',
          plugin: 'file-mount',
          form: 'notice',
          summary: 'mounted L1-50',
          path: 'src/a.ts',
          hash: 'abcdef0123456789',
          totalLines: 100,
          // born 200 at L 1000 -> drift 0.8: warn at the default 0.85,
          // expired at the aggressive 0.5 tier.
          mounted: [{ start: 1, end: 50, born: 200, expired: 0 }],
          added: [{ start: 1, end: 50 }],
          mountKind: 'new',
          savedTokens: 0,
          freshnessThreshold: 0.85,
        },
        provenance: { role: 'inject', label: 'file-mount' },
        form: null,
      },
    ]
    const api = { update: vi.fn().mockResolvedValue({}) }
    const { container } = render(<MountedFilesView {...viewProps(nodes)} api={api} />)
    const dot = container.querySelector('[data-mount-file-freshness]')
    expect(dot?.getAttribute('data-mount-file-freshness')).toBe('warn')
    // The picker defaults to the tier nearest the folded threshold (0.85).
    expect((container.querySelector('[data-mount-tier]') as HTMLSelectElement).value).toBe('standard')
    // Switch to the aggressive tier: the level flips to expired immediately
    // and the new threshold is pushed through the settings api.
    const select = container.querySelector('[data-mount-tier]') as HTMLSelectElement
    select.value = 'aggressive'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(container.querySelector('[data-mount-file-freshness]')?.getAttribute('data-mount-file-freshness')).toBe('expired')
    expect(api.update).toHaveBeenCalledWith({ ns: 'file-mount', patch: { freshnessThreshold: 0.5 } })
  })
})