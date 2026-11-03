import { hashPassword } from '../security/passwordHash';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
let safe = 0;
let vulnerable = 0;

async function post(path: string, body: any) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await r.json().catch(() => ({}));
  const cookie = (r.headers.get('set-cookie') || '').includes('bs_httponly_token');
  return { status: r.status, data, cookie };
}

function report(name: string, attackSucceeded: boolean) {
  if (attackSucceeded) {
    vulnerable++;
    console.log('FAIL ' + name + '  <-- ZAIFLIK: hujum muvaffaqiyatli');
  } else {
    safe++;
    console.log('PASS ' + name);
  }
}

(async () => {
  let r = await post('/api/auth/complete-migration', {
    userId: 'victim-9', login: 'victim9', role: 'admin', phone: '+998 90 111 22 34',
    newPassword: 'Hujum12345', firebasePhoneVerified: true, firebaseUid: 'fake',
  });
  report('T1 soxta firebasePhoneVerified bilan migratsiya va admin sessiya olinmasin', r.data?.success === true || r.cookie);

  r = await post('/api/security/session', { userId: 'victim-8', login: 'victim8', role: 'admin' });
  report('T2 /api/security/session rolni mijozdan olib sessiya bermasin', r.cookie);

  const forgedHash = await hashPassword('Parol123!');
  r = await post('/api/auth/verify-account', {
    login: 'x', password: 'Parol123!',
    adminRecord: { login: 'x', passwordHash: forgedHash, passwordMigrated: true },
  });
  report('T3 verify-account mijoz yuborgan adminRecord ga ishonmasin', r.cookie || r.data?.success === true);

  r = await post('/api/auth/verify-account', { login: 'ADMIN.', password: '1234.', adminRecord: { login: 'ADMIN.' } });
  report('T4 standart "1234." paroli bilan admin sessiyasi olinmasin', r.cookie || r.data?.success === true);

  r = await post('/api/auth/hash-password', { password: 'abcdef' });
  report('T5 /api/auth/hash-password hammaga ochiq xeshlash xizmati bo\'lmasin', typeof r.data?.passwordHash === 'string');

  console.log('\nNATIJA: ' + safe + ' PASS, ' + vulnerable + ' FAIL');
  process.exit(vulnerable > 0 ? 1 : 0);
})().catch((e) => { console.error('TEST XATOSI', e); process.exit(2); });
