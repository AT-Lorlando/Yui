# Push Notifications via FCM — Yui Mobile

Firebase Cloud Messaging (FCM) est gratuit, sans limite de messages, sans carte bancaire. Plan Spark (gratuit permanent).

---

## Vue d'ensemble du flux

```
Orchestrateur (Node.js)
  └─ POST https://fcm.googleapis.com/v1/projects/<id>/messages:send
        ↓
  Firebase Cloud Messaging
        ↓
  Téléphone Android (Google Play Services)
        ↓
  App Yui (via @capacitor-firebase/messaging)
```

---

## 1. Créer le projet Firebase (console web)

1. Aller sur [console.firebase.google.com](https://console.firebase.google.com)
2. **Créer un projet** → nom : `Yui`
3. Désactiver Google Analytics (inutile ici)
4. Dans le projet → **Paramètres** (icône engrenage) → **Paramètres du projet**
5. Onglet **Général** → section "Vos applications" → cliquer **Android**
6. Renseigner :
   - **Nom du package** : `fr.atkoya.yui` (doit matcher `capacitor.config.ts`)
   - Surnom : `Yui`
   - SHA-1 : laisser vide (pas nécessaire pour FCM)
7. Télécharger `google-services.json`
8. Placer le fichier dans `mobile/android/app/google-services.json`

---

## 2. Récupérer la clé de service (côté serveur)

L'API FCM v1 utilise OAuth2 avec un service account, pas une simple API key.

1. Console Firebase → **Paramètres** → onglet **Comptes de service**
2. Cliquer **Générer une nouvelle clé privée** → télécharge un fichier JSON
3. Renommer en `firebase-service-account.json`
4. Placer dans `data/firebase-service-account.json` (ne pas committer — déjà dans `.gitignore`)
5. Ajouter au `.gitignore` si ce n'est pas déjà fait :
   ```
   data/firebase-service-account.json
   ```

---

## 3. Configurer le projet Android

### `mobile/android/build.gradle` (projet root)
```groovy
buildscript {
    dependencies {
        // Ajouter si absent
        classpath 'com.google.gms:google-services:4.4.2'
    }
}
```

### `mobile/android/app/build.gradle`
```groovy
// En bas du fichier, ajouter :
apply plugin: 'com.google.gms.google-services'
```

### `mobile/android/app/src/main/AndroidManifest.xml`
Ajouter dans `<application>` :
```xml
<service
    android:name="io.capawesome.capacitorjs.plugins.firebase.messaging.FirebaseMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

---

## 4. Installer le plugin Capacitor

```bash
cd mobile
npm install @capacitor-firebase/messaging
npx cap sync android
```

---

## 5. Code mobile — enregistrement du token

### `mobile/app/stores/yui.ts` — ajouter le token FCM

```typescript
import { FirebaseMessaging } from '@capacitor-firebase/messaging'

// Dans le store Pinia, ajouter :
const fcmToken = ref<string | null>(null)

async function registerForNotifications() {
  // Demander la permission
  const { receive } = await FirebaseMessaging.requestPermissions()
  if (receive !== 'granted') return

  // Récupérer le token
  const { token } = await FirebaseMessaging.getToken()
  fcmToken.value = token

  // Envoyer le token à l'orchestrateur pour qu'il le sauvegarde
  await fetch(`${apiBase}/devices/fcm-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({ token }),
  })

  // Écouter les notifs en foreground
  FirebaseMessaging.addListener('notificationReceived', (event) => {
    console.log('Notification reçue (foreground):', event.notification)
    // Ajouter un message système dans le chat si besoin
  })
}
```

Appeler `registerForNotifications()` au montage de l'app dans `app/app.vue` :
```typescript
onMounted(() => {
  store.registerForNotifications()
})
```

---

## 6. Orchestrateur — sauvegarder le token et envoyer des notifs

### Installer la dépendance

```bash
npm install google-auth-library
```

### `src/notifications/fcm.ts` — nouveau fichier

```typescript
import { GoogleAuth } from 'google-auth-library'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const TOKEN_FILE = 'data/fcm-token.json'
const SERVICE_ACCOUNT_FILE = 'data/firebase-service-account.json'

function loadToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null
  return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')).token
}

export function saveToken(token: string) {
  writeFileSync(TOKEN_FILE, JSON.stringify({ token }))
}

async function getAccessToken(): Promise<string> {
  const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'))
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  })
  const client = await auth.getClient()
  const { token } = await client.getAccessToken()
  return token!
}

export async function sendNotification(title: string, body: string) {
  const deviceToken = loadToken()
  if (!deviceToken) {
    console.warn('[FCM] Pas de token enregistré, notification ignorée')
    return
  }

  const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'))
  const projectId = serviceAccount.project_id
  const accessToken = await getAccessToken()

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title, body },
          android: {
            priority: 'high',
          },
        },
      }),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    console.error('[FCM] Erreur envoi:', err)
  }
}
```

### `src/input/HttpSource.ts` — ajouter la route de token

```typescript
// Dans les routes existantes, ajouter :
app.post('/devices/fcm-token', authenticate, (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token requis' })
  saveToken(token)
  res.json({ ok: true })
})
```

### Utilisation depuis n'importe où dans l'orchestrateur

```typescript
import { sendNotification } from '../notifications/fcm'

// Exemples d'usage
await sendNotification('Yui', 'Jérémy est rentré à la maison')
await sendNotification('Alarme', 'Timer pizza terminé !')
await sendNotification('Présence', 'Aucun mouvement détecté depuis 2h')
```

---

## 7. Rebuild et test

```bash
# Rebuild l'APK avec les changements Firebase
cd mobile
npm run build:apk && npm run install:apk

# Tester une notif depuis le serveur
curl -X POST http://10.0.0.101:3000/tools/send_test_notification \
  -H "Authorization: Bearer yui" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test", "body": "Ça marche !"}'
```

---

## Résumé des fichiers modifiés/créés

| Fichier | Action |
|---------|--------|
| `mobile/android/app/google-services.json` | Créer (depuis Firebase console) |
| `data/firebase-service-account.json` | Créer (depuis Firebase console) — ne pas committer |
| `mobile/android/build.gradle` | Ajouter plugin google-services |
| `mobile/android/app/build.gradle` | Appliquer plugin google-services |
| `mobile/android/app/src/main/AndroidManifest.xml` | Ajouter FirebaseMessagingService |
| `mobile/app/stores/yui.ts` | Ajouter `registerForNotifications()` |
| `mobile/app/app.vue` | Appeler `registerForNotifications()` au mount |
| `src/notifications/fcm.ts` | Créer (nouveau — logique d'envoi) |
| `src/input/HttpSource.ts` | Ajouter route `POST /devices/fcm-token` |

---

## Notes importantes

- Le token FCM **change** si l'app est réinstallée. L'app le renvoie automatiquement à chaque démarrage.
- En **foreground**, les notifs sont reçues via l'event listener mais n'affichent pas de bannière système — à toi de les gérer dans l'UI.
- En **background/fermée**, Android affiche automatiquement la notification dans le tiroir.
- Le fichier `google-services.json` n'est pas secret (il ne contient pas de clé privée) mais le `firebase-service-account.json` l'est — ne jamais committer.
