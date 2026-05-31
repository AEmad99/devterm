export const S_IFMT = 0o170000
export const S_IFDIR = 0o040000
export const S_IFLNK = 0o120000

/** Render a numeric mode as an ls-style permission string, e.g. "drwxr-xr-x". */
export function formatMode(mode: number, isDir: boolean, isSymlink: boolean): string {
  const type = isSymlink ? 'l' : isDir ? 'd' : '-'
  const rwx = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
  return type + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
}
