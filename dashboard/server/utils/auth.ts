import type { H3Event } from 'h3'
import { getRequestHeader, createError } from 'h3'

export function requireAuth(event: H3Event): void {
  const auth = getRequestHeader(event, 'authorization')
  const token = auth?.split(' ')[1]
  if (!token || token !== process.env.BEARER_TOKEN) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
}
