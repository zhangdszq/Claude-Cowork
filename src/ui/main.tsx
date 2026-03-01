import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QuickWindow } from './components/QuickWindow.tsx'

const isQuick = new URLSearchParams(window.location.search).get('mode') === 'quick'

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		{isQuick ? <QuickWindow /> : <App />}
	</StrictMode>
)

