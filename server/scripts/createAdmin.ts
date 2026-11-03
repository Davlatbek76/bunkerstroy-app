import 'dotenv/config';
import { upsertAdmin } from '../security/adminStore';
import { hashPassword } from '../security/passwordHash';

const role = process.argv[2];
if (role !== 'admin' && role !== 'bunker_admin') {
  console.error('Ishlatish: createAdmin.ts admin | bunker_admin');
  process.exit(1);
}
const prefix = role === 'admin' ? 'ADMIN' : 'BUNKER_ADMIN';
const login = (process.env[prefix + '_LOGIN'] || '').trim();
const phone = (process.env[prefix + '_PHONE'] || '').trim();
const password = process.env.ADMIN_PASSWORD || '';

if (!login || !phone) {
  console.error(prefix + '_LOGIN va ' + prefix + '_PHONE .env faylida bo\'lishi kerak');
  process.exit(1);
}
if (password.length < 12) {
  console.error('ADMIN_PASSWORD kamida 12 belgidan iborat bo\'lishi kerak');
  process.exit(1);
}

(async () => {
  await upsertAdmin({
    id: role === 'admin' ? 'admin-master' : 'bunker-admin-master',
    login,
    role,
    phone,
    passwordHash: await hashPassword(password),
  });
  console.log('OK ' + role + ' yaratildi yoki yangilandi');
  process.exit(0);
})().catch((e) => { console.error('XATO', e.message); process.exit(1); });
