import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QuickWindow } from './components/QuickWindow.tsx'

// Clear splash-seen flag on cold start so splash shows once per launch
sessionStorage.getItem('vk-cowork-app-booted') || (() => {
	localStorage.removeItem('vk-cowork-splash-seen')
	sessionStorage.setItem('vk-cowork-app-booted', 'true')
})()

const isQuick = new URLSearchParams(window.location.search).get('mode') === 'quick'

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		{isQuick ? <QuickWindow /> : <App />}
	</StrictMode>
)

