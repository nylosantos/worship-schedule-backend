require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const {
  PORT = 3000,
  APP_BASE_URL = '',
  CRON_SECRET = '',
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

async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!idToken) return res.status(401).send('Token mancante');
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.auth = decoded;
    next();
  } catch (err) {
    return res.status(401).send('Token non valido');
  }
}

async function requireManageRole(req, res, next) {
  const uid = req.auth?.uid;
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.active) return res.status(403).send('Utente non attivo');
  if (!['root', 'minister'].includes(user.role)) {
    return res.status(403).send('Permesso negato');
  }
  req.appUser = { id: uid, ...user };
  next();
}

async function requireRootRole(req, res, next) {
  const uid = req.auth?.uid;
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.active || user.role !== 'root') {
    return res.status(403).send('Permesso admin richiesto');
  }
  req.appUser = { id: uid, ...user };
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/register-device', authRequired, async (req, res) => {
  const { token, role, preferences, platform } = req.body || {};
  if (!token) return res.status(400).send('token obbligatorio');
  const id = tokenId(token);
  await db
    .collection('notification_devices')
    .doc(id)
    .set(
      {
        token,
        userId: req.auth.uid,
        role: role || 'member',
        preferences: preferences || {},
        enabled: true,
        platform: platform || 'unknown',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  res.json({ ok: true });
});

app.post('/api/unregister-device', authRequired, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).send('token obbligatorio');
  const id = tokenId(token);
  await db
    .collection('notification_devices')
    .doc(id)
    .set(
      {
        enabled: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  res.json({ ok: true });
});

app.post('/api/update-device-preferences', authRequired, async (req, res) => {
  const { token, preferences, enabled } = req.body || {};
  if (!token) return res.status(400).send('token obbligatorio');
  const id = tokenId(token);
  await db
    .collection('notification_devices')
    .doc(id)
    .set(
      {
        preferences: preferences || {},
        enabled: enabled !== false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  res.json({ ok: true });
});

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
  if (!tokens.length) return { success: 0, failure: 0 };
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
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
      notification: {
        title,
        body,
      },
    },
  });
  return {
    success: response.successCount,
    failure: response.failureCount,
  };
}

app.post(
  '/api/admin/send-notification',
  authRequired,
  requireRootRole,
  async (req, res) => {
    const { target, role, userIds, title, body, link, category } = req.body || {};
    if (!title || !body || !category) return res.status(400).send('Payload non valido');

    let recipients = [];
    if (target === 'all') {
      const usersSnap = await db.collection('users').where('active', '==', true).get();
      recipients = usersSnap.docs.map((d) => d.id);
    } else if (target === 'role') {
      const usersSnap = await db
        .collection('users')
        .where('active', '==', true)
        .where('role', '==', role || 'member')
        .get();
      recipients = usersSnap.docs.map((d) => d.id);
    } else if (target === 'users') {
      recipients = Array.isArray(userIds) ? userIds : [];
    } else {
      return res.status(400).send('target non valido');
    }

    const result = await sendToUsers({
      userIds: recipients,
      title,
      body,
      link,
      category,
    });

    res.json({ ok: true, ...result, recipients: recipients.length });
  },
);

app.post('/api/events/emit', authRequired, requireManageRole, async (req, res) => {
  const { type, data } = req.body || {};
  if (!type) return res.status(400).send('type obbligatorio');

  let recipients = [];
  let title = '';
  let body = '';
  let link = '/';
  let category = 'announcements';

  if (type === 'assignment_changed') {
    if (!data?.personId) return res.status(400).send('personId mancante');
    const usersSnap = await db
      .collection('users')
      .where('active', '==', true)
      .where('linkedPersonId', '==', String(data.personId))
      .get();
    recipients = usersSnap.docs.map((d) => d.id);
    category = 'assignment';
    title = 'Nuova assegnazione';
    body = `Sei stato inserito/aggiornato in una scala (${data.serviceDate || ''}).`;
    link = '/schedules';
  } else if (type === 'service_songs_updated') {
    const serviceId = String(data?.serviceId || '');
    if (!serviceId) return res.status(400).send('serviceId mancante');
    const scheduleSnap = await db.collection('schedules').get();
    let assignments = [];
    scheduleSnap.forEach((doc) => {
      const services = doc.data().services || [];
      const service = services.find((s) => s.serviceId === serviceId);
      if (service) assignments = service.assignments || [];
    });
    const personIds = [...new Set(assignments.map((a) => a.personId).filter(Boolean))];
    const usersSnap = await db
      .collection('users')
      .where('active', '==', true)
      .where('linkedPersonId', 'in', personIds.slice(0, 10))
      .get();
    recipients = usersSnap.docs.map((d) => d.id);
    category = 'serviceSongs';
    title = 'Repertorio aggiornato';
    body = `Sono state aggiornate le canzoni del culto (${data.songsCount || 0}).`;
    link = `/services/${serviceId}`;
  } else if (type === 'announcement_created') {
    const usersSnap = await db.collection('users').where('active', '==', true).get();
    recipients = usersSnap.docs.map((d) => d.id);
    category = 'announcements';
    title = 'Nuovo annuncio';
    body = String(data?.title || 'Nuovo annuncio disponibile');
    link = '/';
  } else if (type === 'monthly_schedule_created') {
    const usersSnap = await db.collection('users').where('active', '==', true).get();
    recipients = usersSnap.docs.map((d) => d.id);
    category = 'monthlySchedule';
    title = 'Nuova scala mensile';
    body = `La scala del mese ${data?.month || ''} è disponibile.`;
    link = '/schedules';
  } else if (type === 'catalog_song_created') {
    const usersSnap = await db.collection('users').where('active', '==', true).get();
    recipients = usersSnap.docs.map((d) => d.id);
    category = 'catalog';
    title = 'Nuova canzone in catalogo';
    body = String(data?.title || 'È stata aggiunta una nuova canzone.');
    link = '/songs';
  } else {
    return res.status(400).send('type non supportato');
  }

  const result = await sendToUsers({
    userIds: recipients,
    title,
    body,
    link,
    category,
  });
  res.json({ ok: true, ...result, recipients: recipients.length });
});

app.post('/api/cron/remind-next-month-schedule', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).send('Cron secret non valido');
  }

  const now = new Date();
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const reminderStart = new Date(nextMonthStart);
  reminderStart.setDate(reminderStart.getDate() - 7);
  if (now < reminderStart) {
    return res.json({ ok: true, skipped: true, reason: 'outside reminder window' });
  }

  const month = `${nextMonthStart.getFullYear()}-${String(
    nextMonthStart.getMonth() + 1,
  ).padStart(2, '0')}`;

  const scheduleSnap = await db
    .collection('schedules')
    .where('month', '==', month)
    .limit(1)
    .get();
  if (!scheduleSnap.empty) {
    return res.json({ ok: true, skipped: true, reason: 'schedule already exists' });
  }

  const adminsSnap = await db
    .collection('users')
    .where('active', '==', true)
    .where('role', '==', 'root')
    .get();
  const recipients = adminsSnap.docs.map((d) => d.id);
  const result = await sendToUsers({
    userIds: recipients,
    title: 'Promemoria scala mensile',
    body: `Manca la scala di ${month}. Generala appena possibile.`,
    link: '/schedules/generate',
    category: 'reminder',
  });

  res.json({ ok: true, month, recipients: recipients.length, ...result });
});

app.listen(PORT, () => {
  console.log(`notifications-backend listening on ${PORT}`);
});
