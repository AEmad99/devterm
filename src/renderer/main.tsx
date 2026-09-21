import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/common/ErrorBoundary'
import { useSettings } from './store/settings'
import { applyTheme, getTheme } from './lib/themes'
import { applyDensity } from './lib/density'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// Paint the saved theme's chrome tokens onto the document root before the first
// render so there's no flash of the CSS defaults. The settings store hydrates
// from localStorage synchronously on import.
applyTheme(getTheme(useSettings.getState().themeId))
applyDensity(useSettings.getState().density)

// NOTE: no <React.StrictMode>. Its dev double-invoke of effects mounts→unmounts→
// remounts every pane, which for us means spawning + immediately killing PTYs,
// SSH shells, and the interactive `pi` agent process (exit 0xC000013A). Our
// panes own imperative side effects, so StrictMode does more harm than good.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary
    title="DevTerm hit an error"
    detail="The window stopped drawing. Restore it to show your tabs again. SSH sessions that were already connected stay up; local shells start fresh."
    retryLabel="Restore the window"
  >
    <App />
  </ErrorBoundary>
)
