import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AccountShell from './components/AccountShell.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AccountShell>
      <App />
    </AccountShell>
  </React.StrictMode>,
);
