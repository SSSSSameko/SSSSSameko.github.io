import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AppErrorBoundary from './components/ui/AppErrorBoundary.jsx';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/draw.css';
import './styles/components.css';
import './styles/motion.css';
import './styles/theme.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
