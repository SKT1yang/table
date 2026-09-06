/** 极简静态服务器（零依赖，node ≥22）。手动玩：node scripts/serve.mjs → http://localhost:4195/ */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }

export function createServer() {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const f = path.join(ROOT, p === '/' ? '/index.html' : p)
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  createServer().listen(4195, () => console.log('http://localhost:4195/'))
}
