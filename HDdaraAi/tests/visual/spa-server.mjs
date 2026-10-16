/**
 * Static server with an SPA fallback, for previewing the built H5 bundle.
 *
 * `python3 -m http.server` cannot serve this build: the H5 target uses `history`
 * routing, so `/pages/settings/index` is a real path that no file backs — the
 * request 404s before the app ever sees it. Anything without a file extension is
 * answered with `index.html` and the app routes from there, which is what a
 * production host does.
 *
 *   node tests/visual/spa-server.mjs [port] [dir]
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import process from 'node:process'

const port = Number(process.argv[2] ?? 8799)
const root = process.argv[3] ?? 'dist/build/h5'

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

createServer((request, response) => {
  // `normalize` collapses `..` so a crafted path cannot escape the build dir.
  const path = normalize(decodeURIComponent(request.url.split('?')[0]))
  let file = join(root, path)

  const isAsset = extname(path) !== ''
  const missing = !existsSync(file) || statSync(file).isDirectory()

  if (isAsset && missing) {
    response.writeHead(404).end('not found')
    return
  }

  if (missing) {
    // A route, not a file: hand back the shell and let the app resolve it.
    file = join(root, 'index.html')
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
  })

  createReadStream(file).pipe(response)
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`)
})
