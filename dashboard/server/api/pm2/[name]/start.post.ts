import { pm2Action, pm2StartFromEcosystem, pm2List } from '../../../utils/pm2'
import { requireAuth } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const name = getRouterParam(event, 'name')!
  if (!name.startsWith('yui-')) throw createError({ statusCode: 403, message: 'Not a Yui process' })

  // Check if PM2 already knows this process
  const list = await pm2List().catch(() => [])
  const known = list.some((p) => p.name === name)

  if (known) {
    await pm2Action('start', name)
  } else {
    await pm2StartFromEcosystem(name)
  }

  return { ok: true }
})
