# La maison de Jérémy

## Enceintes et appareils Cast

| Nom | IP | Type | Usage |
|---|---|---|---|
| Salon | 10.0.0.192:8009 | Google Home Max | Sortie vocale TTS (réponses Yui) |
| Chromecaste | 10.0.0.140:8009 | Chromecast | Musique Spotify |
| Google Home | 10.0.0.189:8009 | Google Home | Entrée/salon |
| Nest Hub | 10.0.0.190:8009 | Google Nest Hub | Cuisine |
| Les enceintes | 10.0.0.190:32179 | Cast Group | Toutes les pièces sauf TV |

## Télévision

Samsung TV connectée via SmartThings + Wake-on-LAN

- IP locale : `10.0.0.133`
- MAC : voir `.env` (`SMARTTHINGS_TV_MAC`)
- Chromecast branché sur **HDMI3**
- WoL : broadcast subnet `10.0.0.255:9` (les autres méthodes ne fonctionnent pas)

## Éclairage

Philips Hue — liste les lumières avec `list_lights` si tu as besoin des IDs précis.

## Portes

Nuki smart lock — liste avec `list_doors` pour obtenir les IDs.
