import { createEventStream } from 'h3'
import pm2 from 'pm2'

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const eventStream = createEventStream(event)

  pm2.connect(false, (err) => {
    if (err) { eventStream.close(); return }

    pm2.launchBus((err2, bus) => {
      if (err2) { pm2.disconnect(); eventStream.close(); return }

      const onOut = (packet: any) => {
        if (packet.process?.name === name)
          eventStream.push(JSON.stringify({ type: 'out', data: packet.data, ts: Date.now() })).catch(() => {})
      }
      const onErr = (packet: any) => {
        if (packet.process?.name === name)
          eventStream.push(JSON.stringify({ type: 'err', data: packet.data, ts: Date.now() })).catch(() => {})
      }

      bus.on('log:out', onOut)
      bus.on('log:err', onErr)

      eventStream.onClosed(() => {
        bus.off('log:out', onOut)
        bus.off('log:err', onErr)
        bus.close()
        pm2.disconnect()
      })
    })
  })

  return eventStream.send()
})
