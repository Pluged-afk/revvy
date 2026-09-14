import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

window.storage = {
  get: (key) => {
    const v = localStorage.getItem(key)
    return Promise.resolve(v != null ? { value: v } : null)
  },
  set: (key, value) => {
    localStorage.setItem(key, value)
    return Promise.resolve()
  },
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the service worker in production so Revyy is installable (PWA) and
// its shell opens offline. Prod-only so it never interferes with dev/HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
