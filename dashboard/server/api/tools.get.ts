export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  try {
    return await $fetch(`${config.orchestratorUrl}/tools`, { timeout: 5000 })
  } catch {
    return []
  }
})
