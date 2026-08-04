import { createRoot } from 'react-dom/client';

import App from './App';

import './index.css';

import { setBaseUrl } from '@workspace/api-client-react';
import { getApiBase } from '@/lib/api-base';

// Point generated API client at VITE_API_URL, or same-origin /api on Vercel.
setBaseUrl(getApiBase().replace(/\/$/, '') || null);

createRoot(document.getElementById('root')!).render(<App />);
