import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '../index.css'
import '../pwa/updateGuards.js'
import ErrorBoundary from '../components/ErrorBoundary'
import AdminApp from './AdminApp'

createRoot(document.getElementById('root')).render(
  <StrictMode><ErrorBoundary><BrowserRouter><AdminApp /></BrowserRouter></ErrorBoundary></StrictMode>,
)
