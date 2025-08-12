import { registerSW } from 'virtual:pwa-register';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (confirm('A new version is available. Refresh now?')) {
      updateSW(true); // apply update and reload
    }
  },
  onOfflineReady() {
    console.log('App is ready to work offline');
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
