// 最小复现：后台 shell 里起的 node + spawn 新控制台，定位 dsh-deck dispatch 挂起
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

createServer((req, res) => {
  if (req.url === '/spawn') {
    console.log('[probe] before spawn', new Date().toISOString())
    const line = `start "probe" /D "D:\\coding" cmd /K echo probe-hello`
    const t0 = Date.now()
    const child = spawn('cmd.exe', ['/d', '/s', '/c', line], { detached: true, stdio: 'ignore' })
    console.log('[probe] spawn returned in', Date.now() - t0, 'ms')
    child.on('error', (e) => console.log('[probe] error:', e.message))
    child.unref()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(200)
  res.end('ok')
}).listen(3099, '127.0.0.1', () => console.log('[probe] listening 3099'))
