import { exec } from 'node:child_process'

export default defineEventHandler(async (): Promise<object[]> => {
  return new Promise((resolve) => {
    exec('pm2 jlist', (_err, stdout) => {
      if (!stdout?.trim()) {
        resolve([])
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve([])
      }
    })
  })
})
