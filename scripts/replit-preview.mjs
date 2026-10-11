// Replit's managed webview expects port 5000. Keep Vite on its normal port,
// forwarding TCP so HTTP and Vite's WebSocket connection both work unchanged.
import { createServer, connect } from 'node:net'

const server = createServer((browser) => {
  const vite = connect({ host: '127.0.0.1', port: 5173 })
  browser.pipe(vite).pipe(browser)
  browser.on('error', () => vite.destroy())
  vite.on('error', () => browser.destroy())
  browser.on('close', () => vite.destroy())
  vite.on('close', () => browser.destroy())
})

server.listen(5000, '0.0.0.0', () => {
  console.log('[preview] forwarding port 5000 to Vite on port 5173')
})
