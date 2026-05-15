export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const api = $fetch.create({
    headers: {
      Authorization: `Bearer ${config.public.bearerToken}`,
    },
  })
  return { provide: { api } }
})
