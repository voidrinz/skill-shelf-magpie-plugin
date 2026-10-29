import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import App from './App';
import { initializeMagpie } from './magpie';
import { Toaster } from './ShelfToast';
import { TooltipProvider } from './ShelfTooltip';
import './style.css';
import './shelf-shell.css';
import './shelf-finder.css';
import './shelf-menu.css';
import './shelf-settings.css';
import './shelf-form.css';
import './shelf-button.css';
import './shelf-dialog.css';

initializeMagpie().then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><TooltipProvider delayDuration={300} skipDelayDuration={150}><Toaster /><App /></TooltipProvider></React.StrictMode>);
}).catch(error => {
  document.getElementById('root')!.textContent = `无法打开书架：${error.message}`;
});
