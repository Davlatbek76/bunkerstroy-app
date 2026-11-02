import crypto from 'crypto';
import assert from 'assert';
import { hashPassword, verifyPassword, isLegacyScryptHash } from './passwordHash';

function legacyHash(pw: string) {
  const salt = crypto.randomBytes(16);
  const d = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `$argon2id$v=19$m=65536,t=3,p=4$${salt.toString('hex')}$${d.toString('base64')}`;
}

(async () => {
  const h = await hashPassword('Parol123!');
  assert(h.startsWith('$argon2id$') && !isLegacyScryptHash(h));
  console.log('OK yangi hash haqiqiy argon2id');

  const r1 = await verifyPassword('Parol123!', h);
  assert(r1.valid && !r1.needsRehash);
  console.log('OK togri parol');

  assert(!(await verifyPassword('Notogri', h)).valid);
  console.log('OK notogri parol rad etildi');

  const old = legacyHash('Eski456!');
  assert(isLegacyScryptHash(old));
  const r2 = await verifyPassword('Eski456!', old);
  assert(r2.valid && r2.needsRehash);
  console.log('OK eski xesh tekshirildi, qayta xeshlash kerak');

  assert(!(await verifyPassword('Notogri', old)).valid);
  console.log('OK eski xeshda notogri parol rad etildi');

  assert(!(await verifyPassword('x', '')).valid);
  assert(!(await verifyPassword('x', 'abc')).valid);
  console.log('OK bosh/buzuq xesh rad etildi');
})().catch((e) => { console.error('XATO', e); process.exit(1); });
