/** `file-mount` namespace dictionaries (view tab label + list strings). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'file-mount'

/** The file-mount dictionary key set (the source of truth for both locales). */
export type FileMountKey =
  | 'view.fileMount'
  | 'list.empty'
  | 'list.hash'
  | 'list.lines'
  | 'kind.new'
  | 'kind.increment'
  | 'kind.remount'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The mounted-files view tab label and list strings. */
    'file-mount': FileMountKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FileMountKey, string> = {
  'view.fileMount': '挂载文件',
  'list.empty': '尚无文件挂载：模型读取文件后，这里会显示已进入上下文的行范围。',
  'list.hash': '指纹',
  'list.lines': '行',
  'kind.new': '新挂载',
  'kind.increment': '增量',
  'kind.remount': '重挂载',
}

/** English dictionary. */
export const en: Record<FileMountKey, string> = {
  'view.fileMount': 'Mounted Files',
  'list.empty': 'Nothing mounted yet: when the model reads a file, the line ranges already in context show up here.',
  'list.hash': 'hash',
  'list.lines': 'lines',
  'kind.new': 'new',
  'kind.increment': 'increment',
  'kind.remount': 'remount',
}
