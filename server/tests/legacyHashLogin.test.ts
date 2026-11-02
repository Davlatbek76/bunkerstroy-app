import crypto from 'crypto';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

function legacyHash(pw: string) {
  const salt = crypto.randomBytes(16);
  const d = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `$argon2id$v=19$m=65536,t=3,p=4$${salt.toString('hex')}$${d.toString('base64')}`;
}

async function verify(password: string, passwordHash: string) {
  const r = await fetch(`${BASE}/api/auth/verify-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: 'legacy_user',
      password,
      accountRecord: {
        id: 'test-legacy-1', login: 'legacy_user', role: 'individual',
        phone: '+998 90 000 00 01', passwordMigrated: true, passwordHash,
      },
    }),
  });
  return r.json() as Promise<any>;
}

(async () => {
  const old = legacyHash('Eski456!');

  const bad = await verify('Notogri', old);
  assert.equal(bad.success, false);
  console.log('OK eski xeshda notogri parol rad etildi');

  const good = await verify('Eski456!', old);
  assert.equal(good.success, true);
  assert.ok(good.passwordHash?.startsWith('$argon2id$'), 'yangi xesh qaytishi kerak');
  assert.ok(!/m=65536,t=3,p=4/.test(good.passwordHash), 'yangi xesh eski formatda emas');
  console.log('OK eski xesh bilan kirildi va haqiqiy Argon2id xesh qaytdi');

  const again = await verify('Eski456!', good.passwordHash);
  assert.equal(again.success, true);
  assert.equal(again.passwordHash, undefined);
  console.log('OK yangi xesh bilan kirildi, qayta xeshlash kerak emas');

  console.log('LEGACY LOGIN TESTI O\'TDI');
})().catch((e) => { console.error('XATO', e); process.exit(1); });
