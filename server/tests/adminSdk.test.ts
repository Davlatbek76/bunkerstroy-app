import { adminDb } from '../security/firebaseAdmin';

(async () => {
  const db = adminDb();
  await db.doc('server_admins/test').set({ login: 'x' });
  const snap = await db.doc('server_admins/test').get();
  if (!snap.exists || snap.data()?.login !== 'x') throw new Error('o\'qib bo\'lmadi');
  await db.doc('server_admins/test').delete();
  console.log('OK Admin SDK emulatorda yozdi va o\'qidi');
  process.exit(0);
})().catch((e) => { console.error('XATO', e); process.exit(1); });
