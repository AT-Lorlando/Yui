import { pm2List, readEcosystemApps } from '../../utils/pm2'

export default defineEventHandler(async () => {
  const [running, ecosystem] = await Promise.all([
    pm2List().catch(() => [] as import('pm2').ProcessDescription[]),
    Promise.resolve(readEcosystemApps()),
  ])

  const runningByName = new Map(running.map((p) => [p.name, p]))

  // Merge: ecosystem defines the canonical list; PM2 provides live status
  return ecosystem.map((app) => {
    const live = runningByName.get(app.name)
    if (live) return live
    // Process defined in ecosystem but not known to PM2 yet
    return {
      name: app.name,
      pid: null,
      pm2_env: { status: 'stopped', restart_time: 0, pm_uptime: 0 },
      monit: { memory: 0, cpu: 0 },
    }
  })
})
