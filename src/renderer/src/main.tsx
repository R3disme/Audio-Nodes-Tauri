import React from 'react'
import ReactDOM from 'react-dom/client'
import './platform/bridge'
import { App } from './App'
import { useAudioStore } from './store/audioStore'
import { useSettingsStore } from './store/settingsStore'
import { audioEngine } from './audio/backend'
import './index.css'

// Expose for debugging / e2e tests
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__audioStore = useAudioStore
  ;(window as unknown as Record<string, unknown>).__settingsStore = useSettingsStore
  ;(window as unknown as Record<string, unknown>).__audioEngine = audioEngine
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
