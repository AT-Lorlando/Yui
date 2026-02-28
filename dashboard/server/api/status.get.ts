export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  try {
    const data = await $fetch<{ servers: { name: string; tools: number }[]; totalTools: number }>(
      `${config.orchestratorUrl}/status`,
      { timeout: 5000 },
    )
    return { online: true, ...data }
  } catch {
    return { online: false, servers: [], totalTools: 0 }
  }
})
