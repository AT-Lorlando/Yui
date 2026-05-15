import { pm2Action } from '../../../utils/pm2'
import { requireAuth } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const name = getRouterParam(event, 'name')!
  if (!name.startsWith('yui-')) throw createError({ statusCode: 403, message: 'Not a Yui process' })
  await pm2Action('restart', name)
  return { ok: true }
})
