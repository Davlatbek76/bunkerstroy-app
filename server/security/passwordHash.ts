import crypto from 'crypto';
import { promisify } from 'util';
import argon2 from 'argon2';

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

const ARGON2_OPTIONS = {
  type: 2 as const, // 2 = argon2id
  memoryCost: 19456, // 19 MiB (OWASP)
  timeCost: 2,
  parallelism: 1,
};

// Eski "soxta argon2id": $argon2id$v=19$m=65536,t=3,p=4$<32 hex salt>$<base64 scrypt>
const LEGACY_RE = /^\$argon2id\$v=19\$m=65536,t=3,p=4\$([0-9a-f]{32})\$([A-Za-z0-9+/]+=*)$/;

export function isLegacyScryptHash(stored: string): boolean {
  return LEGACY_RE.test(stored);
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export interface VerifyResult {
  valid: boolean;
  needsRehash: boolean;
}

export async function verifyPassword(plain: string, stored: string): Promise<VerifyResult> {
  const fail: VerifyResult = { valid: false, needsRehash: false };
  try {
    if (!plain || !stored || typeof stored !== 'string') return fail;

    const legacy = LEGACY_RE.exec(stored);
    if (legacy) {
      const salt = Buffer.from(legacy[1], 'hex');
      const derived = await scryptAsync(plain, salt, 32, { N: 16384, r: 8, p: 1 });
      const a = Buffer.from(derived.toString('base64'), 'utf8');
      const b = Buffer.from(legacy[2], 'utf8');
      if (a.length !== b.length) return fail;
      const ok = crypto.timingSafeEqual(a, b);
      return { valid: ok, needsRehash: ok };
    }

    if (!stored.startsWith('$argon2id$')) return fail;
    const ok = await argon2.verify(stored, plain);
    if (!ok) return fail;
    return { valid: true, needsRehash: argon2.needsRehash(stored, ARGON2_OPTIONS) };
  } catch {
    return fail;
  }
}
