/// <reference types="vite/client" />
/// <reference types="electron" />
import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { DevTermApi } from '@shared/types'

declare global {
  interface Window {
    devterm: DevTermApi
  }
  // The in-app browser pane uses Electron's <webview> tag, which isn't a standard
  // JSX intrinsic element. Type it so TSX compiles and a ref is the Electron
  // WebviewTag (loadURL/goBack/reload/canGoBack/…).
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<Electron.WebviewTag>, Electron.WebviewTag> & {
        src?: string
        partition?: string
        allowpopups?: boolean
      }
    }
  }
}

export {}
