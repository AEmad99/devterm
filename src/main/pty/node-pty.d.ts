// Minimal typings for the `node-pty` import specifier. The runtime package is
// `@homebridge/node-pty-prebuilt-multiarch` (aliased to `node-pty` in package.json),
// whose bundled .d.ts declares a different module name — so we declare the surface
// we use here and map the specifier to this file via tsconfig `paths`.
declare module 'node-pty' {
  export interface IPty {
    readonly pid: number
    readonly process: string
    onData(cb: (data: string) => void): void
    // exitCode can be undefined at runtime when the console host dies abnormally.
    onExit(cb: (e: { exitCode: number | undefined; signal?: number }) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
  }

  export interface IPtyForkOptions {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: { [key: string]: string | undefined }
    encoding?: string | null
  }

  export interface IWindowsPtyForkOptions extends IPtyForkOptions {
    /** Use the conpty.dll bundled with node-pty instead of the in-box one. Windows only. */
    useConptyDll?: boolean
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions
  ): IPty
}
