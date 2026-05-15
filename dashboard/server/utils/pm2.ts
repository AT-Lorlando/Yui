import pm2 from 'pm2'
import { createRequire } from 'module'
import path from 'path'

// Ecosystem config path — project root (one level up from dashboard/ in dev)
function ecosystemPath(): string {
  const cwd = process.cwd()
  const root = path.basename(cwd) === 'dashboard' ? path.resolve(cwd, '..') : cwd
  return path.join(root, 'ecosystem.config.js')
}

export interface EcosystemApp {
  name: string
  script: string
  cwd?: string
  interpreter?: string
  env?: Record<string, string>
}

export function readEcosystemApps(): EcosystemApp[] {
  try {
    const req = createRequire(import.meta.url)
    // Clear cache so env changes are picked up on reload
    delete req.cache[req.resolve(ecosystemPath())]
    const config = req(ecosystemPath())
    return (config.apps ?? []).filter((a: EcosystemApp) => a.name?.startsWith('yui-'))
  } catch {
    return []
  }
}

export function pm2List(): Promise<pm2.ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.connect(false, (err) => {
      if (err) return reject(err)
      pm2.list((err2, list) => {
        pm2.disconnect()
        if (err2) return reject(err2)
        resolve(list)
      })
    })
  })
}

export function pm2Action(action: 'start' | 'stop' | 'restart', name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect(false, (err) => {
      if (err) return reject(err)
      pm2[action](name, (err2: Error | null) => {
        pm2.disconnect()
        if (err2) return reject(err2)
        resolve()
      })
    })
  })
}

export function pm2StartFromEcosystem(name: string): Promise<void> {
  const apps = readEcosystemApps()
  const app = apps.find((a) => a.name === name)
  if (!app) throw createError({ statusCode: 404, message: `No ecosystem entry for "${name}"` })

  return new Promise((resolve, reject) => {
    pm2.connect(false, (err) => {
      if (err) return reject(err)
      pm2.start(app as Parameters<typeof pm2.start>[0], (err2) => {
        pm2.disconnect()
        if (err2) return reject(err2)
        resolve()
      })
    })
  })
}
