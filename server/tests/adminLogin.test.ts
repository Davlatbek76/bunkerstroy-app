import 'dotenv/config';
import assert from 'node:assert/strict';
import { upsertAdmin } from '../security/adminStore';
import { adminDb } from '../security/firebaseAdmin';
import { hashPassword } from '../security/passwordHash';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

async function verify(body: any) {
  const r = await fetch(BASE + '/api/auth/verify-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await r.json().catch(() => ({}));
  const cookie = r.headers.get('set-cookie') || '';
  return { data, cookie };
}

(async () => {
  await upsertAdmin({
    id: 'test-admin-1', login: 'TEST_ADMIN_LOCAL', role: 'admin',
    phone: '+998 71 000 00 00', passwordHash: await hashPassword('Test-Admin-Parol-1!'),
  });
  try {
    let r = await verify({ login: 'test_admin_local', password: 'Test-Admin-Parol-1!' });
    assert.equal(r.data.success, true);
    assert.equal(r.data.verifiedRole, 'admin');
    assert.ok(r.cookie.includes('bs_httponly_token'));
    assert.equal(r.data.passwordHash, undefined);
    console.log("OK server omboridagi admin to'g'ri parol bilan kirdi, xesh qaytarilmadi");

    r = await verify({ login: 'TEST_ADMIN_LOCAL', password: 'Notogri-parol-1' });
    assert.equal(r.data.success, false);
    assert.ok(!r.cookie.includes('bs_httponly_token'));
    console.log("OK noto'g'ri parol rad etildi");

    const forged = await hashPassword('Hujum-Parol-1!');
    r = await verify({
      login: 'TEST_ADMIN_LOCAL', password: 'Hujum-Parol-1!',
      adminRecord: { login: 'TEST_ADMIN_LOCAL', passwordHash: forged, passwordMigrated: true },
    });
    assert.equal(r.data.success, false);
    assert.ok(!r.cookie.includes('bs_httponly_token'));
    console.log("OK mijoz yuborgan soxta adminRecord e'tiborga olinmadi");
  } finally {
    await adminDb().doc('server_admins/test-admin-1').delete();
  }
  console.log("ADMIN LOGIN TESTI O'TDI");
  process.exit(0);
})().catch((e) => { console.error('XATO', e); process.exit(1); });
