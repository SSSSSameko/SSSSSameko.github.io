import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './apple-v3/tokens.css';
import './apple-v3/app.css';
import './apple-v3/draw.css';
import './apple-v3/live.css';
import './apple-v3/motion.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
