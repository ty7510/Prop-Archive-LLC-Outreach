import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { ApiRequestError } from './api.ts'
import { ToastProvider } from './components/Toast.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry once on network trouble, never on a clear answer (4xx or "not built yet").
      retry: (count, err) => {
        if (err instanceof ApiRequestError && (err.status < 500 || err.notBuilt)) return false
        return count < 1
      },
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
