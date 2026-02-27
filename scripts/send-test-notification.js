/* eslint-disable no-console */
require('dotenv').config();
const crypto = require('crypto');
const admin = require('firebase-admin');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const {
  APP_BASE_URL = '',
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
} = process.env;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error('Variabili Firebase Admin mancanti');
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();
const messaging = admin.messaging();

function tokenId(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const CATEGORIES = [
  'assignment',
  'serviceSongs',
  'announcements',
  'catalog',
  'monthlySchedule',
  'reminder',
];

async function collectDeviceTokensByUserIds(userIds, category) {
  if (!userIds.length) return [];
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 10) {
    chunks.push(userIds.slice(i, i + 10));
  }

  const tokens = [];
  for (const group of chunks) {
    const snap = await db
      .collection('notification_devices')
      .where('enabled', '==', true)
      .where('userId', 'in', group)
      .get();

    snap.forEach((doc) => {
      const data = doc.data();
      const allow = data.preferences?.[category];
      if (allow === false) return;
      if (data.token) tokens.push(data.token);
    });
  }
  return [...new Set(tokens)];
}

async function sendToUsers({ userIds, title, body, link, category }) {
  const tokens = await collectDeviceTokensByUserIds(userIds, category);
  if (!tokens.length) return { success: 0, failure: 0, tokens: 0 };
  const response = await messaging.sendEachForMulticast({
    tokens,
    data: {
      title,
      body,
      link: link || APP_BASE_URL || '/',
      category,
    },
    webpush: {
      fcmOptions: {
        link: link || APP_BASE_URL || '/',
      },
    },
  });
  return {
    success: response.successCount,
    failure: response.failureCount,
    tokens: tokens.length,
  };
}

async function askTargetUsers(rl) {
  console.log('\nDestinazione:');
  console.log('[1] Tutti');
  console.log('[2] Per ruolo');
  console.log('[3] Utenti specifici');
  const targetChoice = (await rl.question('Scegli opzione (1-3): ')).trim();

  if (targetChoice === '1') {
    const usersSnap = await db.collection('users').where('active', '==', true).get();
    return usersSnap.docs.map((d) => d.id);
  }

  if (targetChoice === '2') {
    console.log('\nRuolo:');
    console.log('[1] root');
    console.log('[2] minister');
    console.log('[3] member');
    const roleChoice = (await rl.question('Scegli ruolo (1-3): ')).trim();
    const role = roleChoice === '1' ? 'root' : roleChoice === '2' ? 'minister' : 'member';
    const usersSnap = await db
      .collection('users')
      .where('active', '==', true)
      .where('role', '==', role)
      .get();
    return usersSnap.docs.map((d) => d.id);
  }

  const usersSnap = await db.collection('users').where('active', '==', true).get();
  const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!users.length) return [];

  console.log('\nUtenti disponibili (marque con X digitando i numeri):');
  users.forEach((u, idx) => {
    const role = u.role || 'member';
    console.log(`[ ] ${idx + 1}. ${u.name || u.email || u.id} (${role})`);
  });
  const raw = await rl.question(
    'Digite numeri separati da virgola (es: 1,3,7): ',
  );
  const picks = [...new Set(raw.split(',').map((x) => Number(x.trim())).filter(Boolean))];
  const selected = picks
    .filter((n) => n >= 1 && n <= users.length)
    .map((n) => users[n - 1].id);
  return selected;
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log('=== Invio Notifica Test (Backend) ===');
    const recipients = await askTargetUsers(rl);
    if (!recipients.length) {
      console.log('Nessun destinatario selezionato.');
      return;
    }

    const title = (await rl.question('Titolo: ')).trim();
    const body = (await rl.question('Messaggio: ')).trim();
    const linkInput = (await rl.question('Link (opzionale, es /schedules): ')).trim();

    console.log('\nCategoria:');
    CATEGORIES.forEach((c, idx) => console.log(`[${idx + 1}] ${c}`));
    const catChoice = Number((await rl.question('Scegli categoria (1-6): ')).trim());
    const category = CATEGORIES[catChoice - 1] || 'announcements';

    if (!title || !body) {
      console.log('Titolo e messaggio sono obbligatori.');
      return;
    }

    const result = await sendToUsers({
      userIds: recipients,
      title,
      body,
      link: linkInput || undefined,
      category,
    });

    console.log('\nInvio completato:');
    console.log(`- destinatari: ${recipients.length}`);
    console.log(`- token validi: ${result.tokens}`);
    console.log(`- success: ${result.success}`);
    console.log(`- failure: ${result.failure}`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('\nErrore:', err?.message || err);
  process.exit(1);
});
