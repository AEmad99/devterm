import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Shown above the error. */
  title: string
  /** What stayed alive, so the operator knows a retry is local. */
  detail: string
  retryLabel?: string
}

interface ErrorBoundaryState {
  error: Error | null
  nonce: number
}

/**
 * Keeps a render crash inside one surface. A retry remounts only this
 * boundary's children; sibling panes and the main-process shells stay up.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, nonce: 0 }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui]', this.props.title, error, info.componentStack)
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))
  }

  render(): ReactNode {
    const { error, nonce } = this.state
    if (error) {
      return (
        <div className="pane-error" role="alert">
          <div className="pane-error-title">{this.props.title}</div>
          <p className="pane-error-detail">{this.props.detail}</p>
          <pre className="pane-error-msg">{error.message || 'Unknown error'}</pre>
          <button type="button" className="empty-cta" onClick={this.retry}>
            {this.props.retryLabel ?? 'Try again'}
          </button>
        </div>
      )
    }
    return <Fragment key={nonce}>{this.props.children}</Fragment>
  }
}
