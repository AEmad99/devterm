/**
 * Descriptive file/folder icons based on Lucide (https://lucide.dev/).
 *
 * Replaces the single generic file glyph with type-aware icons for folders,
 * images, video, audio, archives, code, documents, spreadsheets, config,
 * keys, executables and symlinks. Color is applied through CSS classes so
 * selected rows can override it cleanly via `currentColor`.
 */
import {
  Folder,
  FolderOpen,
  FolderSymlink,
  File,
  FileSymlink,
  FileText,
  FileCode,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileTerminal,
  FileJson,
  FileSpreadsheet,
  FileType,
  FileCog,
  FileKey,
  FileLock
} from 'lucide-react'
import type { FileEntry } from '@shared/types'
import type { LucideProps } from 'lucide-react'

type IconComponent = React.ComponentType<LucideProps>

const EXT_ICON_MAP: Record<string, [IconComponent, string]> = {
  // images
  png: [FileImage, 'file-image'],
  jpg: [FileImage, 'file-image'],
  jpeg: [FileImage, 'file-image'],
  gif: [FileImage, 'file-image'],
  bmp: [FileImage, 'file-image'],
  webp: [FileImage, 'file-image'],
  ico: [FileImage, 'file-image'],
  svg: [FileImage, 'file-image'],
  tiff: [FileImage, 'file-image'],

  // video
  mp4: [FileVideo, 'file-media'],
  mov: [FileVideo, 'file-media'],
  avi: [FileVideo, 'file-media'],
  mkv: [FileVideo, 'file-media'],
  webm: [FileVideo, 'file-media'],
  flv: [FileVideo, 'file-media'],
  wmv: [FileVideo, 'file-media'],

  // audio
  mp3: [FileAudio, 'file-media'],
  wav: [FileAudio, 'file-media'],
  ogg: [FileAudio, 'file-media'],
  flac: [FileAudio, 'file-media'],
  aac: [FileAudio, 'file-media'],
  m4a: [FileAudio, 'file-media'],
  wma: [FileAudio, 'file-media'],

  // archives
  zip: [FileArchive, 'file-archive'],
  tar: [FileArchive, 'file-archive'],
  gz: [FileArchive, 'file-archive'],
  bz2: [FileArchive, 'file-archive'],
  '7z': [FileArchive, 'file-archive'],
  rar: [FileArchive, 'file-archive'],
  xz: [FileArchive, 'file-archive'],
  tgz: [FileArchive, 'file-archive'],

  // code / markup
  js: [FileCode, 'file-code'],
  jsx: [FileCode, 'file-code'],
  mjs: [FileCode, 'file-code'],
  cjs: [FileCode, 'file-code'],
  ts: [FileCode, 'file-code'],
  tsx: [FileCode, 'file-code'],
  py: [FileCode, 'file-code'],
  java: [FileCode, 'file-code'],
  c: [FileCode, 'file-code'],
  cpp: [FileCode, 'file-code'],
  h: [FileCode, 'file-code'],
  hpp: [FileCode, 'file-code'],
  cs: [FileCode, 'file-code'],
  go: [FileCode, 'file-code'],
  rs: [FileCode, 'file-code'],
  rb: [FileCode, 'file-code'],
  php: [FileCode, 'file-code'],
  swift: [FileCode, 'file-code'],
  kt: [FileCode, 'file-code'],
  scala: [FileCode, 'file-code'],
  html: [FileCode, 'file-code'],
  htm: [FileCode, 'file-code'],
  css: [FileCode, 'file-code'],
  scss: [FileCode, 'file-code'],
  sass: [FileCode, 'file-code'],
  less: [FileCode, 'file-code'],
  xml: [FileCode, 'file-code'],
  vue: [FileCode, 'file-code'],
  svelte: [FileCode, 'file-code'],

  // json
  json: [FileJson, 'file-data'],

  // shell / terminal scripts
  sh: [FileTerminal, 'file-code'],
  bash: [FileTerminal, 'file-code'],
  zsh: [FileTerminal, 'file-code'],
  fish: [FileTerminal, 'file-code'],
  ps1: [FileTerminal, 'file-code'],

  // text documents
  txt: [FileText, 'file-text'],
  md: [FileText, 'file-text'],
  rtf: [FileText, 'file-text'],
  log: [FileText, 'file-text'],

  // office / document types
  pdf: [FileType, 'file-text'],
  doc: [FileText, 'file-text'],
  docx: [FileText, 'file-text'],
  odt: [FileText, 'file-text'],

  // spreadsheets
  csv: [FileSpreadsheet, 'file-data'],
  xls: [FileSpreadsheet, 'file-data'],
  xlsx: [FileSpreadsheet, 'file-data'],
  ods: [FileSpreadsheet, 'file-data'],

  // config / data
  yaml: [FileCog, 'file-config'],
  yml: [FileCog, 'file-config'],
  toml: [FileCog, 'file-config'],
  ini: [FileCog, 'file-config'],
  cfg: [FileCog, 'file-config'],
  conf: [FileCog, 'file-config'],
  env: [FileCog, 'file-config'],
  properties: [FileCog, 'file-config'],

  // keys / certs
  key: [FileKey, 'file-key'],
  pem: [FileKey, 'file-key'],
  crt: [FileKey, 'file-key'],
  pub: [FileKey, 'file-key'],
  pgp: [FileKey, 'file-key'],
  gpg: [FileKey, 'file-key'],
  asc: [FileKey, 'file-key'],

  // lock files
  lock: [FileLock, 'file-key'],

  // executables / libraries
  exe: [FileCog, 'file-exec'],
  dll: [FileCog, 'file-exec'],
  so: [FileCog, 'file-exec'],
  dylib: [FileCog, 'file-exec'],
  bin: [FileCog, 'file-exec'],
  app: [FileCog, 'file-exec']
}

const DOTFILE_MAP: Record<string, [IconComponent, string]> = {
  '.gitignore': [FileCog, 'file-config'],
  '.gitattributes': [FileCog, 'file-config'],
  '.gitmodules': [FileCog, 'file-config'],
  '.env': [FileCog, 'file-config'],
  '.envrc': [FileCog, 'file-config'],
  '.bashrc': [FileTerminal, 'file-code'],
  '.zshrc': [FileTerminal, 'file-code'],
  '.vimrc': [FileTerminal, 'file-code'],
  '.nanorc': [FileTerminal, 'file-code'],
  '.editorconfig': [FileCog, 'file-config'],
  '.prettierrc': [FileCog, 'file-config'],
  '.eslintrc': [FileCog, 'file-config'],
  '.dockerignore': [FileCog, 'file-config'],
  dockerfile: [FileCog, 'file-config']
}

function extension(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0) return ''
  return name.slice(i + 1).toLowerCase()
}

export interface FileTypeIconProps {
  entry: FileEntry
  /** Whether the directory is currently expanded (only meaningful for folders). */
  expanded?: boolean
  size?: number
}

export function FileTypeIcon({ entry, expanded, size = 15 }: FileTypeIconProps) {
  let Icon: IconComponent
  let cls: string

  if (entry.isDir) {
    Icon = entry.isSymlink ? FolderSymlink : expanded ? FolderOpen : Folder
    cls = 'file-folder'
  } else if (entry.isSymlink) {
    Icon = FileSymlink
    cls = 'file-symlink'
  } else {
    const nameLower = entry.name.toLowerCase()
    const dotMatch = DOTFILE_MAP[nameLower]
    const extMatch = EXT_ICON_MAP[extension(entry.name)]
    const match = dotMatch ?? extMatch
    if (match) {
      ;[Icon, cls] = match
    } else {
      Icon = File
      cls = 'file-generic'
    }
  }

  return (
    <span className={`tree-icon ${cls}`}>
      <Icon size={size} />
    </span>
  )
}
