// Local Postgres+pgvector stand-in for tests. NOT used in the demo (Neon is).
// usage: node server.mjs [port] [dataDir|memory]
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
let vector
try { ({ vector } = await import('@electric-sql/pglite-pgvector')) }
catch { ({ vector } = await import('@electric-sql/pglite/vector')) }
const port = Number(process.argv[2] || 54329)
const dir = process.argv[3] && process.argv[3] !== 'memory' ? process.argv[3] : undefined
const db = await PGlite.create({ dataDir: dir, extensions: { vector } })
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 })
await server.start()
console.log(`pglite listening on 127.0.0.1:${port}`)
const stop = async () => { await server.stop(); await db.close(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
