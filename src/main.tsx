import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './style.css'
import { useStore } from './state/store'

// E2E 诊断入口（只读使用；不影响生产逻辑）
;(window as unknown as { __store: typeof useStore }).__store = useStore

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

