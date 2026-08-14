/** `file-mount` namespace dictionaries (view tab label + list strings). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'file-mount'

/** The file-mount dictionary key set (the source of truth for both locales). */
export type FileMountKey =
  | 'view.fileMount'
  | 'list.empty'
  | 'list.hash'
  | 'list.lines'
  | 'list.searchPlaceholder'
  | 'list.sortNet'
  | 'list.sortPath'
  | 'kind.new'
  | 'kind.increment'
  | 'kind.remount'
  | 'kind.dedup'
  | 'summary.netTotal'
  | 'summary.cny'
  | 'row.net'
  | 'row.changed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The mounted-files view tab label and list strings. */
    'file-mount': FileMountKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FileMountKey, string> = {
  'view.fileMount': '挂载文件',
  'list.empty': '尚无文件挂载：模型读取文件后，这里会显示已进入上下文的行范围。若一直为空，可能是插件未启用或当前环境不兼容。',
  'list.hash': '指纹',
  'list.lines': '行',
  'list.searchPlaceholder': '搜索路径…',
  'list.sortNet': '按净节省排序',
  'list.sortPath': '按路径排序',
  'kind.new': '新挂载',
  'kind.increment': '增量',
  'kind.remount': '重挂载',
  'kind.dedup': '去重',
  'summary.netTotal': '本次会话净节省 ≈ {n} tokens',
  'summary.cny': '（约 ¥{n}）',
  'row.net': '净节省 ≈ {n} tokens',
  'row.changed': '文件已变更，已重挂',
}

/** English dictionary. */
export const en: Record<FileMountKey, string> = {
  'view.fileMount': 'Mounted Files',
  'list.empty': 'Nothing mounted yet: when the model reads a file, the line ranges already in context show up here. If it stays empty, the plugin may be disabled or incompatible with this DSH build.',
  'list.hash': 'hash',
  'list.lines': 'lines',
  'list.searchPlaceholder': 'Search paths…',
  'list.sortNet': 'Sort by net savings',
  'list.sortPath': 'Sort by path',
  'kind.new': 'new',
  'kind.increment': 'increment',
  'kind.remount': 'remount',
  'kind.dedup': 'dedup',
  'summary.netTotal': 'Net saved this session ≈ {n} tokens',
  'summary.cny': '(≈ ¥{n})',
  'row.net': 'net ≈ {n} tokens',
  'row.changed': 'changed, remounted',
}
