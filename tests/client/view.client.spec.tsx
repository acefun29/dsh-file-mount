// @vitest-environment jsdom
/**
 * Component coverage: the mounted-files view renders the folded ledger and
 * the empty hint. The slot registry glue is thin (index.ts) and rides the
 * real boot smoke in the release checklist instead of a unit bench.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MountedFilesView, VIEW_ID } from '../../src/client/MountedFilesView.tsx'
import type { MountedFilesViewProps } from '../../src/client/MountedFilesView.tsx'
import type { FileMountKey } from '../../src/client/locales.ts'
import { zh } from '../../src/client/locales.ts'

/**
 * Minimal stand-in for the DSH slot runtime share: `useSession` carries
 * session state only, and the conversation nodes hang off the registered Chat
 * target snapshot behind `useConversation`.
 *
 * Every other member of the standard prop kit (0.2.0's extra session hooks and
 * the `conversation.view` owner callbacks) is an inert double; the single cast
 * at the end keeps this double independent of later additions to that kit.
 */
function viewProps(
  nodes: readonly ConversationNode[],
  viewRequest: { view: string; focus: string } | null = null,
  completeViewRequest: () => void = () => undefined,
): MountedFilesViewProps {
  const t = (key: FileMountKey): string => zh[key]
  return {
    useSession: (selector: (snapshot: { sessionId: string }) => unknown) => selector({ sessionId: 's1' }),
    useSessions: () => undefined,
    useConversation: (selector: (snapshot: unknown) => unknown) =>
      selector({
        views: { get: (target: string) => (target === 'chat' ? { legacy: { nodes } } : undefined) },
        activeTargets: new Set(['chat']),
      }),
    useProjection: () => undefined,
    useInput: () => undefined,
    inputActions: {},
    sessionId: 's1',
    // DSH 0.2.0 owner props of a 'conversation.view' entry (inspectCall,
    // viewRequest, openView, completeViewRequest); this view only consumes the
    // focus request.
    inspectCall: undefined,
    viewRequest,
    openView: () => undefined,
    completeViewRequest,
    t,
  } as unknown as MountedFilesViewProps
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
        producer: { role: 'inject', label: 'file-mount' },
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
    expect(rows[0]!.querySelector('[data-mount-lines]')?.textContent).toBe(
      zh['row.coverage'].replace('{n}', '50').replace('{total}', '100'),
    )
    expect(rows[0]!.querySelector('[data-mount-progress]')?.getAttribute('aria-valuenow')).toBe('50')
    expect(rows[0]!.querySelector('[data-mount-net]')?.textContent).toBe(zh['row.net'].replace('{n}', '0'))
    expect(rows[0]!.getAttribute('data-mount-kind')).toBe('new')
    // No born / no usage → unknown, not green fresh.
    expect(rows[0]!.querySelector('[data-mount-file-freshness]')?.getAttribute('data-mount-file-freshness')).toBe('unknown')
    expect(container.querySelector('[data-mount-summary]')?.getAttribute('title'))
      .toBe(zh['summary.breakdown'].replace('{saved}', '0').replace('{spent}', '0'))
  })

  it('pins savings and search above a separately scrolling file list', () => {
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
        producer: { role: 'inject', label: 'file-mount' },
        form: 'notice',
      },
    ]
    const { container } = render(<MountedFilesView {...viewProps(nodes)} />)
    const header = container.querySelector('[data-mount-header]')
    const body = container.querySelector('[data-mount-body]')
    expect(header).not.toBeNull()
    expect(body).not.toBeNull()
    expect(header!.contains(container.querySelector('[data-mount-summary]')!)).toBe(true)
    expect(header!.contains(container.querySelector('[data-mount-search]')!)).toBe(true)
    expect(body!.contains(container.querySelector('[data-mount-row]')!)).toBe(true)
    expect(header!.nextElementSibling).toBe(body)
    expect((body as HTMLElement).scrollTop).toBe(0)
  })

  it('floors negative net savings at 0 in the header and row', () => {
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
          spentTokens: 22,
        },
        producer: { role: 'inject', label: 'file-mount' },
        form: 'notice',
      },
    ]
    const { container } = render(<MountedFilesView {...viewProps(nodes)} />)
    expect(container.querySelector('[data-mount-net-total]')?.textContent)
      .toBe(zh['summary.netTotal'].replace('{n}', '0'))
    expect(container.querySelector('[data-mount-net]')?.textContent)
      .toBe(zh['row.net'].replace('{n}', '0'))
    expect(container.querySelector('[data-mount-cny]')?.textContent)
      .toBe(zh['summary.cny'].replace('{n}', '0.00'))
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
        producer: { role: 'inject', label: 'file-mount' },
        form: null,
      },
    ]
    const nodes = vi.fn<() => ConversationNode[]>()
    nodes.mockReturnValue(a)
    const props = {
      useSession: (selector: (snapshot: { sessionId: string }) => unknown) => selector({ sessionId: 's1' }),
      useConversation: (selector: (snapshot: unknown) => unknown) =>
        selector({
          views: { get: (target: string) => (target === 'chat' ? { legacy: { nodes: nodes() } } : undefined) },
          activeTargets: new Set(['chat']),
        }),
      useSessions: () => undefined,
      useProjection: () => undefined,
      useInput: () => undefined,
      inputActions: {},
      sessionId: 's1',
      inspectCall: undefined,
      viewRequest: null,
      openView: () => undefined,
      completeViewRequest: () => undefined,
      t: (key: FileMountKey): string => zh[key],
    } as unknown as MountedFilesViewProps
    const { container, rerender } = render(<MountedFilesView {...props} />)
    expect(container.querySelector('[data-mount-empty]')).not.toBeNull()
    nodes.mockReturnValue(b)
    rerender(<MountedFilesView {...props} />)
    expect(container.querySelectorAll('[data-mount-row]')).toHaveLength(1)
    expect(container.querySelector('[data-mount-empty]')).toBeNull()
  })

  // DSH 0.2.0: the shell stores a one-shot focus request until the ADDRESSED
  // view acknowledges it, so an unacknowledging registrant would leave the
  // request pending for the rest of the session.
  it('acknowledges a focus request addressed to this view', () => {
    const completeViewRequest = vi.fn()
    const { container } = render(
      <MountedFilesView {...viewProps([], { view: VIEW_ID, focus: 'src/a.ts' }, completeViewRequest)} />,
    )
    expect(container.querySelector('[data-mount-empty]')).not.toBeNull()
    expect(completeViewRequest).toHaveBeenCalledTimes(1)
  })

  it('leaves a focus request addressed to another view unanswered', () => {
    const completeViewRequest = vi.fn()
    render(
      <MountedFilesView {...viewProps([], { view: 'token-viewer', focus: 'x' }, completeViewRequest)} />,
    )
    expect(completeViewRequest).not.toHaveBeenCalled()
  })
})