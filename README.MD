- changeLightState(state): Change l'état des lumières (états possibles: "on", "off").
- changeShuttersState(state): Change l'état des stores (états possibles: "open", "close").
- changeVolume(target, action): Change le volume de la cible spécifiée (cibles possibles: "speakers", "tv"; actions possibles: "up", "down").
- changeTemperature(action): Change la température du thermostat (actions possibles: "increase", "decrease").
- turnoff(target): Éteint l'appareil spécifié (cibles possibles: "tv", "lights", "speakers").
- turnOn(target): Allume l'appareil spécifié (cibles possibles: "tv", "lights", "speakers").
- changeChannel(channel): Change la chaîne de la télévision (paramètre channel pour spécifier la chaîne souhaitée).
- togglePlayback(action): Met en pause ou reprend la lecture du contenu (actions possibles: "pause", "resume").
- lockDoor(action): Verrouille ou déverrouille la porte (actions possibles: "lock", "unlock").
- toggleAlarm(action): Active ou désactive le système d'alarme (actions possibles: "activate", "deactivate").

npm install node-hue-api

const { discovery, HueApi } = require("node-hue-api");

async function discoverBridge() {
  const bridges = await discovery.nupnpSearch();
  if (bridges.length === 0) {
    throw new Error("Aucun pont Hue trouvé");
  }
  return bridges[0].ipaddress;
}

async function getApi() {
  const ipAddress = await discoverBridge();
  // Utilisez votre nom d'utilisateur Hue ici.
  // Pour créer un nom d'utilisateur, consultez la documentation de l'API Hue: https://developers.meethue.com/develop/get-started-2/
  const username = "your-hue-username";
  return new HueApi(ipAddress, username);
}

getApi().then((api) => {
  console.log("Connecté au pont Hue");
});

curl -X POST localhost:3000/command -f --header "Content-Type: application/json" --data '{"password":"password"}'

# TODO

- [] Ajouter des tests
- [] Logger instance