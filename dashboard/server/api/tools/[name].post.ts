export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const name = getRouterParam(event, 'name')
  const body = await readBody(event)

  return $fetch(`${config.orchestratorUrl}/tools/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.bearerToken}`,
      'Content-Type': 'application/json',
    },
    body,
  })
})
