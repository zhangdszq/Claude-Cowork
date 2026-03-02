import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QuickWindow } from './components/QuickWindow.tsx'

const isQuick = new URLSearchParams(window.location.search).get('mode') === 'quick'

if (isQuick) {
	document.documentElement.style.background = 'transparent'
	document.body.style.background = 'transparent'
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		{isQuick ? <QuickWindow /> : <App />}
	</StrictMode>
)

