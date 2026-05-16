export const MCP_GROUPS: Record<string, string[]> = {
  'Domotique':    ['hue', 'nuki', 'somfy'],
  'Médias':       ['spotify', 'chromecast', 'samsung'],
  'Productivité': ['calendar', 'gmail', 'linear', 'obsidian'],
  'Info':         ['weather', 'browser'],
  'Utilitaires':  ['timer'],
}

const GROUP_ORDER = ['Domotique', 'Médias', 'Productivité', 'Info', 'Utilitaires']

export function groupServers<T extends { name: string }>(
  servers: T[],
): { group: string; items: T[] }[] {
  const grouped: Record<string, T[]> = {}
  const ungrouped: T[] = []

  for (const server of servers) {
    const shortName = server.name.replace('mcp-', '')
    const group = Object.entries(MCP_GROUPS).find(([, names]) => names.includes(shortName))?.[0]
    if (group) {
      if (!grouped[group]) grouped[group] = []
      grouped[group].push(server)
    } else {
      ungrouped.push(server)
    }
  }

  const result: { group: string; items: T[] }[] = GROUP_ORDER
    .filter((g) => grouped[g]?.length)
    .map((g) => ({ group: g, items: grouped[g] }))

  if (ungrouped.length) result.push({ group: 'Autre', items: ungrouped })

  return result
}
