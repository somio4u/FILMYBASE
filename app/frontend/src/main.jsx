import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import AiBackground from './AiBackground.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import PerfToggle from './PerfToggle.jsx'
import OdiaKeyToggle from './OdiaKeyToggle.jsx'
import FullscreenToggle from './FullscreenToggle.jsx'
import { initPerfMode } from './perfMode.js'

initPerfMode()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <AiBackground />
      <App />
      <PerfToggle />
      <FullscreenToggle />
      <OdiaKeyToggle />
    </ErrorBoundary>
  </StrictMode>,
)
