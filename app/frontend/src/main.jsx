import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import AiBackground from './AiBackground.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AiBackground />
    <App />
  </StrictMode>,
)
