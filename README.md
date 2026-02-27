# Worship Schedule - Notifications Backend

Backend Node.js (Render) per gestione notifiche push via Firebase Cloud Messaging.

## Endpoint principali

- `GET /health`
- `POST /api/register-device` (auth utente)
- `POST /api/unregister-device` (auth utente)
- `POST /api/update-device-preferences` (auth utente)
- `POST /api/events/emit` (auth root/minister)
- `POST /api/admin/send-notification` (auth root)
- `POST /api/cron/remind-next-month-schedule` (header `x-cron-secret`)

## Setup locale

1. Copia `.env.example` in `.env`.
2. Inserisci credenziali Firebase Admin.
3. `npm install`
4. `npm run dev`

## Deploy Render

- Runtime: Node 18+
- Start command: `npm start`
- Root directory: `backend`
- Env vars: vedi `.env.example`
