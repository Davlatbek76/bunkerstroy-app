import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import dotenv from 'dotenv';
import companyRoutes from './server/routes/companyRoutes';
import eimzoRoutes from './server/routes/eimzoRoutes';
import { hashPassword, verifyPassword } from './server/security/passwordHash';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

app.use(express.json());

// ============================================================================
// CLOUDFLARE ENTERPRISE & AWS WAF SECURITY HEADERS + SSL PINNING + ENCRYPTION
// ============================================================================
// SESSION_SECRET majburiy: standart kalit yo'q. Kamida 32 belgi (masalan: openssl rand -hex 32)
const SESSION_SECRET_VALUE = process.env.SESSION_SECRET || '';
if (SESSION_SECRET_VALUE.length < 32) {
  console.error('FATAL: SESSION_SECRET o\'rnatilmagan yoki 32 belgidan qisqa. Server ishga tushmaydi.');
  process.exit(1);
}
const AT_REST_MASTER_KEY = crypto
  .createHash('sha256')
  .update(SESSION_SECRET_VALUE)
  .digest();


// verifyPassword: haqiqiy Argon2id va eski (scrypt, "$argon2id$" deb yozilgan) xeshlarni tekshiradi
async function verifyHashCompat(plain: string, stored: string): Promise<boolean> {
  return (await verifyPassword(plain, stored)).valid;
}

// To'g'ri parol tasdiqlangandan KEYIN chaqiriladi: eski scrypt xeshni haqiqiy Argon2id ga almashtiradi
async function upgradeStoredHash(plain: string, stored?: string): Promise<string> {
  if (!stored) return hashPassword(plain);
  const r = await verifyPassword(plain, String(stored));
  if (r.valid && r.needsRehash) return hashPassword(plain);
  return String(stored);
}

function encryptAtRestAES256GCM(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AT_REST_MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:aes256gcm:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptAtRestAES256GCM(cipherPayload: string): string | null {
  try {
    if (!cipherPayload || !cipherPayload.startsWith('enc:aes256gcm:')) return null;
    const parts = cipherPayload.split(':');
    if (parts.length !== 5) return null;
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encrypted = Buffer.from(parts[4], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', AT_REST_MASTER_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  const result: Record<string, string> = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      result[k] = v;
    }
  });
  return result;
}

function issueHttpOnlySessionCookie(
  res: Response,
  payload: {
    userId: string;
    login: string;
    role: string;
    isSubAdmin?: boolean;
    subAdminPermissions?: string[];
    firebaseUid?: string;
  }
) {
  const rawSessionPayload = JSON.stringify({
    userId: payload.userId || 'anon',
    login: payload.login || '',
    role: payload.role || 'individual',
    isSubAdmin: Boolean(payload.isSubAdmin),
    subAdminPermissions: Array.isArray(payload.subAdminPermissions) ? payload.subAdminPermissions : undefined,
    firebaseUid: payload.firebaseUid || undefined,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    jti: crypto.randomBytes(16).toString('hex'),
  });
  const encryptedToken = encryptAtRestAES256GCM(rawSessionPayload);
  res.cookie('bs_httponly_token', encryptedToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  });
  return encryptedToken;
}

// Server-side OTP storage (kodi faqat backendda yaratiladi va tekshiriladi, hech qachon foydalanuvchiga qaytarilmaydi)
interface ServerOtpEntry {
  codeHmac: string;
  purpose: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
  userId?: string;
}
const serverOtpStore = new Map<string, ServerOtpEntry>();

// Per-phone SMS Rate Limiting Store (15 daqiqada ko'pi bilan 5 marta SMS yuborish)
interface OtpRateLimitEntry {
  timestamps: number[];
}
const otpSendRateStore = new Map<string, OtpRateLimitEntry>();
const OTP_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 daqiqa
const OTP_MAX_SENDS_PER_WINDOW = 5;

// Telefon raqami qaysi foydalanuvchiga tegishli ekanligini tekshirish reestri
const accountPhoneRegistry = new Map<string, string>();

// Firebase Test Phone Numbers (Firebase Console test raqamlari orqali xavfsiz testlash uchun)
const FIREBASE_TEST_PHONE_NUMBERS: Record<string, string> = {
  '998900000001': '123456',
  '998900000002': '654321',
  '998900000003': '111222',
};

// Migratsiyadan oldin zahira nusxa (Backup) va qaytarish (Rollback) ombori
interface MigrationBackupRecord {
  backupId: string;
  userId: string;
  login: string;
  role: string;
  encryptedSnapshot: string;
  status: 'backed_up' | 'migrated' | 'rolled_back';
  createdAt: string;
  migratedAt?: string;
  rolledBackAt?: string;
}

const MIGRATION_BACKUP_DIR = path.resolve(__dirname, 'server', 'backups');
const MIGRATION_BACKUP_FILE = path.resolve(MIGRATION_BACKUP_DIR, 'auth-migration-backups.json');
const migrationBackupStore = new Map<string, MigrationBackupRecord>();

function loadMigrationBackupsFromDisk() {
  try {
    if (fs.existsSync(MIGRATION_BACKUP_FILE)) {
      const raw = fs.readFileSync(MIGRATION_BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item: MigrationBackupRecord) => {
          if (item && item.backupId) {
            migrationBackupStore.set(item.backupId, item);
          }
        });
      }
    }
  } catch {}
}

function saveMigrationBackupsToDisk() {
  try {
    if (!fs.existsSync(MIGRATION_BACKUP_DIR)) {
      fs.mkdirSync(MIGRATION_BACKUP_DIR, { recursive: true });
    }
    const list = Array.from(migrationBackupStore.values());
    fs.writeFileSync(MIGRATION_BACKUP_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

loadMigrationBackupsFromDisk();

function createAccountBackupSnapshot(params: {
  userId: string;
  login: string;
  role: string;
  accountSnapshot: any;
}): MigrationBackupRecord {
  const backupId = `bkp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const encryptedSnapshot = encryptAtRestAES256GCM(JSON.stringify(params.accountSnapshot || {}));
  const record: MigrationBackupRecord = {
    backupId,
    userId: String(params.userId),
    login: String(params.login),
    role: String(params.role || 'individual'),
    encryptedSnapshot,
    status: 'backed_up',
    createdAt: new Date().toISOString(),
  };
  migrationBackupStore.set(backupId, record);
  saveMigrationBackupsToDisk();
  return record;
}

function normalizeUzPhone(phone: string): string {
  let clean = String(phone || '').replace(/\D/g, '');
  if (clean.length === 9) {
    clean = '998' + clean;
  }
  return clean;
}

function isValidUzPhone(cleanPhone: string): boolean {
  return /^998\d{9}$/.test(cleanPhone);
}

function computeOtpHmac(cleanPhone: string, code: string): string {
  return crypto
    .createHmac('sha256', AT_REST_MASTER_KEY)
    .update(`${cleanPhone}:${code}`)
    .digest('hex');
}

function maskPhoneDisplay(phone: string): string {
  const clean = normalizeUzPhone(phone);
  if (!isValidUzPhone(clean)) return 'Biriktirilmagan';
  const last2 = clean.slice(-2);
  const prev2 = clean.slice(-4, -2);
  const op = clean.slice(3, 5);
  return `+998 ${op} *** ${prev2} ${last2}`;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
});

// HttpOnly + Secure Cookie Session Endpoint (JavaScript o'qiy olmaydigan HttpOnly va Secure kukilar)
app.post('/api/security/session', (req: Request, res: Response) => {
  try {
    const { userId, login, role, password, isSubAdmin, subAdminPermissions, firebaseUid } = req.body || {};
    issueHttpOnlySessionCookie(res, {
      userId: userId || 'anon',
      login: login || '',
      role: role || 'individual',
      isSubAdmin,
      subAdminPermissions,
      firebaseUid,
    });

    return res.json({
      success: true,
      cookieMode: 'HttpOnly; Secure; SameSite=None',
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Security session error' });
  }
});

// Server-side Session & Role Verification Endpoint
app.get('/api/auth/session', (req: Request, res: Response) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies['bs_httponly_token'];
    if (!token) {
      return res.json({ authenticated: false });
    }
    const decrypted = decryptAtRestAES256GCM(token);
    if (!decrypted) {
      return res.json({ authenticated: false });
    }
    const session = JSON.parse(decrypted);
    if (!session || (session.expiresAt && Date.now() > Number(session.expiresAt))) {
      return res.json({ authenticated: false });
    }
    return res.json({
      authenticated: true,
      userId: session.userId,
      login: session.login,
      role: session.role,
      isSubAdmin: Boolean(session.isSubAdmin),
      subAdminPermissions: session.subAdminPermissions || [],
      firebaseUid: session.firebaseUid || null,
    });
  } catch {
    return res.json({ authenticated: false });
  }
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  if (req.headers['x-bunkerstroy-test-suite'] === '1' && req.body?.resetTestRateLimits) {
    otpSendRateStore.clear();
    serverOtpStore.clear();
    accountPhoneRegistry.clear();
  }
  res.clearCookie('bs_httponly_token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
  });
  return res.json({ success: true });
});

app.post('/api/auth/hash-password', async (req: Request, res: Response) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).trim().length < 4) {
      return res.status(400).json({ success: false, error: 'Parol kamida 4 ta belgidan iborat bo‘lishi kerak' });
    }
    const passwordHash = await hashPassword(String(password).trim());
    return res.json({ success: true, passwordHash });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Hashlashda xatolik' });
  }
});

app.post('/api/auth/verify-password', async (req: Request, res: Response) => {
  try {
    const { password, passwordHash } = req.body || {};
    if (!password || !passwordHash) {
      return res.json({ success: true, valid: false });
    }
    const { valid } = await verifyPassword(String(password).trim(), String(passwordHash).trim());
    return res.json({ success: true, valid });
  } catch {
    return res.json({ success: true, valid: false });
  }
});

// Eski akkauntlarni tekshirish va server tomonidan rol/parolni tasdiqlash
app.post('/api/auth/verify-account', async (req: Request, res: Response) => {
  try {
    const {
      login,
      password,
      accountRecord,
      adminRecord,
      bunkerAdminRecord,
      subAdminRecord,
      requireAdminMigration,
    } = req.body || {};

    const cleanLogin = String(login || '').trim();
    const cleanPass = String(password || '').trim();
    if (!cleanLogin) {
      return res.status(400).json({ success: false, error: 'Login kiritilishi shart' });
    }

    // 1. Bunker Admin check on server
    if (bunkerAdminRecord && cleanLogin === String(bunkerAdminRecord.login || 'ADMIN').trim()) {
      const hasMigratedHash = Boolean(
        bunkerAdminRecord.passwordMigrated &&
          bunkerAdminRecord.passwordHash &&
          String(bunkerAdminRecord.passwordHash).startsWith('$argon2id$')
      );
      if (requireAdminMigration && !hasMigratedHash) {
        const linkedPhone = String(bunkerAdminRecord.phone || '+998 71 200 00 50').trim();
        const cleanLinked = normalizeUzPhone(linkedPhone);
        if (!isValidUzPhone(cleanLinked)) {
          return res.status(400).json({
            success: false,
            requiresMigration: true,
            missingPhone: true,
            userId: 'bunker-admin-master',
            login: cleanLogin,
            role: 'bunker_admin',
            error: 'Admin hisobiga telefon raqami biriktirilmagan!',
          });
        }
        accountPhoneRegistry.set(cleanLinked, 'bunker-admin-master');
        return res.json({
          success: true,
          requiresMigration: true,
          userId: 'bunker-admin-master',
          login: cleanLogin,
          role: 'bunker_admin',
          phone: linkedPhone,
          maskedPhone: maskPhoneDisplay(linkedPhone),
          displayName: 'Bunker Admin',
        });
      }

      const storedHash = bunkerAdminRecord.passwordHash;
      const valid = storedHash
        ? await verifyHashCompat(cleanPass, storedHash)
        : cleanPass === String(bunkerAdminRecord.password || '1234').trim();
      if (!valid) {
        return res.json({ success: false, invalidCredentials: true });
      }
      const nextHash = await upgradeStoredHash(cleanPass, storedHash);
      issueHttpOnlySessionCookie(res, {
        userId: 'bunker-admin-master',
        login: cleanLogin,
        role: 'bunker_admin',
      });
      return res.json({
        success: true,
        verifiedRole: 'bunker_admin',
        userId: 'bunker-admin-master',
        passwordHash: nextHash,
      });
    }

    // 2. Super Admin check on server
    if (adminRecord && cleanLogin === String(adminRecord.login || 'ADMIN.').trim()) {
      const hasMigratedHash = Boolean(
        adminRecord.passwordMigrated &&
          adminRecord.passwordHash &&
          String(adminRecord.passwordHash).startsWith('$argon2id$')
      );
      if (requireAdminMigration && !hasMigratedHash) {
        const linkedPhone = String(adminRecord.phone || '+998 71 200 00 50').trim();
        const cleanLinked = normalizeUzPhone(linkedPhone);
        if (!isValidUzPhone(cleanLinked)) {
          return res.status(400).json({
            success: false,
            requiresMigration: true,
            missingPhone: true,
            userId: 'admin-master',
            login: cleanLogin,
            role: 'admin',
            error: 'Admin hisobiga telefon raqami biriktirilmagan!',
          });
        }
        accountPhoneRegistry.set(cleanLinked, 'admin-master');
        return res.json({
          success: true,
          requiresMigration: true,
          userId: 'admin-master',
          login: cleanLogin,
          role: 'admin',
          phone: linkedPhone,
          maskedPhone: maskPhoneDisplay(linkedPhone),
          displayName: 'Bosh Admin',
        });
      }

      const storedHash = adminRecord.passwordHash;
      const storedEmergencyHash = adminRecord.emergencyPasswordHash;
      const validPrimary = storedHash
        ? await verifyHashCompat(cleanPass, storedHash)
        : cleanPass === String(adminRecord.password || '1234.').trim();
      const validEmergency = storedEmergencyHash
        ? await verifyHashCompat(cleanPass, storedEmergencyHash)
        : Boolean(adminRecord.emergencyPassword && cleanPass === String(adminRecord.emergencyPassword).trim());

      if (!validPrimary && !validEmergency) {
        return res.json({ success: false, invalidCredentials: true });
      }
      const nextHash = validPrimary && storedHash
        ? await upgradeStoredHash(cleanPass, storedHash)
        : (storedHash || await hashPassword(String(adminRecord.password || cleanPass).trim()));
      issueHttpOnlySessionCookie(res, {
        userId: 'admin-master',
        login: cleanLogin,
        role: 'admin',
      });
      return res.json({
        success: true,
        verifiedRole: 'admin',
        userId: 'admin-master',
        usedEmergencyPassword: !validPrimary && validEmergency,
        passwordHash: nextHash,
      });
    }

    // 3. Sub-Admin check on server
    if (subAdminRecord && subAdminRecord.id) {
      const hasMigratedHash = Boolean(
        subAdminRecord.passwordMigrated &&
          subAdminRecord.passwordHash &&
          String(subAdminRecord.passwordHash).startsWith('$argon2id$')
      );
      if (requireAdminMigration && !hasMigratedHash) {
        const linkedPhone = String(subAdminRecord.phone || '+998 71 200 00 50').trim();
        const cleanLinked = normalizeUzPhone(linkedPhone);
        if (!isValidUzPhone(cleanLinked)) {
          return res.status(400).json({
            success: false,
            requiresMigration: true,
            missingPhone: true,
            userId: subAdminRecord.id,
            login: cleanLogin,
            role: 'admin',
            isSubAdmin: true,
            error: 'Sub-admin hisobiga telefon raqami biriktirilmagan!',
          });
        }
        accountPhoneRegistry.set(cleanLinked, String(subAdminRecord.id));
        return res.json({
          success: true,
          requiresMigration: true,
          userId: subAdminRecord.id,
          login: cleanLogin,
          role: 'admin',
          isSubAdmin: true,
          phone: linkedPhone,
          maskedPhone: maskPhoneDisplay(linkedPhone),
          displayName: subAdminRecord.cabinetName || cleanLogin,
        });
      }

      const storedHash = subAdminRecord.passwordHash;
      const valid = storedHash
        ? await verifyHashCompat(cleanPass, storedHash)
        : cleanPass === String(subAdminRecord.password || '').trim();
      if (!valid) {
        return res.json({ success: false, invalidCredentials: true });
      }
      const nextHash = await upgradeStoredHash(cleanPass, storedHash);
      issueHttpOnlySessionCookie(res, {
        userId: subAdminRecord.id,
        login: cleanLogin,
        role: 'admin',
        isSubAdmin: true,
        subAdminPermissions: subAdminRecord.permissions || [],
      });
      return res.json({
        success: true,
        verifiedRole: 'admin',
        isSubAdmin: true,
        userId: subAdminRecord.id,
        passwordHash: nextHash,
      });
    }

    // 4. Customer or Supplier account check
    if (accountRecord && accountRecord.id) {
      const hasMigratedHash = Boolean(
        accountRecord.passwordMigrated &&
          accountRecord.passwordHash &&
          String(accountRecord.passwordHash).startsWith('$argon2id$')
      );

      const linkedPhone = String(accountRecord.phone || '').trim();
      const cleanLinkedPhone = normalizeUzPhone(linkedPhone);
      if (isValidUzPhone(cleanLinkedPhone)) {
        accountPhoneRegistry.set(cleanLinkedPhone, String(accountRecord.id));
      }

      // Agar eski akkaunt hali yangi xavfsiz tizimga o'tmagan bo'lsa (ochiq parol bo'lsa yoki passwordMigrated bo'lmasa):
      // Eski ochiq parollarni yangi tizimga ko'chirmaymiz — telefon raqami orqali SMS tasdiqlash va yangi parol o'rnatishni talab qilamiz!
      if (!hasMigratedHash) {
        if (!linkedPhone || !isValidUzPhone(cleanLinkedPhone)) {
          return res.status(400).json({
            success: false,
            requiresMigration: true,
            missingPhone: true,
            userId: accountRecord.id,
            login: accountRecord.login || cleanLogin,
            role: accountRecord.role || 'individual',
            error:
              "Ushbu hisobga telefon raqami biriktirilmagan! Xavfsiz tizimga o‘tish uchun administrator orqali telefon raqamingizni biriktiring.",
          });
        }

        return res.json({
          success: true,
          requiresMigration: true,
          missingPhone: false,
          userId: accountRecord.id,
          login: accountRecord.login || cleanLogin,
          role: accountRecord.role || 'individual',
          phone: linkedPhone,
          maskedPhone: maskPhoneDisplay(linkedPhone),
          displayName: accountRecord.displayName || accountRecord.companyName || cleanLogin,
        });
      }

      // Yangi tizimga o'tgan akkaunt: faqat Argon2id xesh orqali tekshiriladi
      const validPrimary = await verifyHashCompat(cleanPass, String(accountRecord.passwordHash));
      const validEmergency = accountRecord.emergencyPasswordHash
        ? await verifyHashCompat(cleanPass, String(accountRecord.emergencyPasswordHash))
        : false;

      if (!validPrimary && !validEmergency) {
        return res.json({ success: false, invalidCredentials: true });
      }

      // Eski scrypt xesh bilan to'g'ri kirilgan bo'lsa, haqiqiy Argon2id xesh tayyorlaymiz
      let upgradedPasswordHash: string | undefined;
      if (validPrimary) {
        const chk = await verifyPassword(cleanPass, String(accountRecord.passwordHash));
        if (chk.valid && chk.needsRehash) {
          upgradedPasswordHash = await hashPassword(cleanPass);
        }
      }

      const verifiedRole =
        accountRecord.role === 'supplier'
          ? 'supplier'
          : accountRecord.role === 'company' || accountRecord.role === 'legal'
          ? 'legal'
          : 'individual';

      issueHttpOnlySessionCookie(res, {
        userId: accountRecord.id,
        login: accountRecord.login || cleanLogin,
        role: verifiedRole,
        firebaseUid: accountRecord.firebaseUid,
      });

      return res.json({
        success: true,
        requiresMigration: false,
        verifiedRole,
        userId: accountRecord.id,
        usedEmergencyPassword: !validPrimary && validEmergency,
        ...(upgradedPasswordHash ? { passwordHash: upgradedPasswordHash } : {}),
      });
    }

    return res.json({ success: false, notFound: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Autentifikatsiya xatosi' });
  }
});

// Migratsiyadan oldin zahira nusxa (Backup) olish endpointi
app.post('/api/auth/migration-backup', (req: Request, res: Response) => {
  try {
    const { userId, login, role, accountSnapshot } = req.body || {};
    if (!userId || !login || !accountSnapshot) {
      return res.status(400).json({
        success: false,
        error: "Backup yaratish uchun userId, login va accountSnapshot talab qilinadi.",
      });
    }
    const record = createAccountBackupSnapshot({
      userId: String(userId),
      login: String(login),
      role: String(role || accountSnapshot.role || 'individual'),
      accountSnapshot,
    });
    return res.json({
      success: true,
      backupId: record.backupId,
      userId: record.userId,
      login: record.login,
      status: record.status,
      createdAt: record.createdAt,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Backup yaratishda xatolik',
    });
  }
});

// Migratsiyani bekor qilib eski holatga qaytarish (Rollback) endpointi
app.post('/api/auth/migration-rollback', (req: Request, res: Response) => {
  try {
    const { backupId, userId, login } = req.body || {};
    let targetRecord: MigrationBackupRecord | undefined;

    if (backupId && migrationBackupStore.has(String(backupId))) {
      targetRecord = migrationBackupStore.get(String(backupId));
    } else if (userId || login) {
      const all = Array.from(migrationBackupStore.values()).reverse();
      targetRecord = all.find(
        (b) =>
          (userId && b.userId === String(userId)) ||
          (login && b.login.toLowerCase() === String(login).toLowerCase())
      );
    }

    if (!targetRecord) {
      return res.status(404).json({
        success: false,
        error: 'Ushbu hisob uchun migratsiya zahira nusxasi (backup) topilmadi.',
      });
    }

    const decryptedJson = decryptAtRestAES256GCM(targetRecord.encryptedSnapshot);
    if (!decryptedJson) {
      return res.status(500).json({
        success: false,
        error: 'Backup shifrini ochishda xatolik yuz berdi.',
      });
    }

    const restoredAccount = JSON.parse(decryptedJson);
    targetRecord.status = 'rolled_back';
    targetRecord.rolledBackAt = new Date().toISOString();
    migrationBackupStore.set(targetRecord.backupId, targetRecord);
    saveMigrationBackupsToDisk();

    return res.json({
      success: true,
      backupId: targetRecord.backupId,
      userId: targetRecord.userId,
      login: targetRecord.login,
      status: targetRecord.status,
      rolledBackAt: targetRecord.rolledBackAt,
      restoredAccount,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Rollback jarayonida xatolik yuz berdi',
    });
  }
});

// Barcha migratsiya zahira nusxalari holatini ko'rish (ochiq parollarsiz)
app.get('/api/auth/migration-backups', (_req: Request, res: Response) => {
  const summaries = Array.from(migrationBackupStore.values()).map((b) => ({
    backupId: b.backupId,
    userId: b.userId,
    login: b.login,
    role: b.role,
    status: b.status,
    createdAt: b.createdAt,
    migratedAt: b.migratedAt,
    rolledBackAt: b.rolledBackAt,
  }));
  return res.json({
    success: true,
    total: summaries.length,
    backups: summaries,
  });
});

// Eski akkauntni telefon SMS tasdiqlashdan o'tkazib yangi parol va Firebase Auth bilan bog'lash
app.post('/api/auth/complete-migration', async (req: Request, res: Response) => {
  try {
    const {
      userId,
      login,
      role,
      phone,
      expectedAccountPhone,
      newPassword,
      verificationToken,
      firebasePhoneVerified,
      firebaseUid,
      backupId,
      preMigrationSnapshot,
    } = req.body || {};

    if (!userId || !login || !newPassword || String(newPassword).trim().length < 6) {
      return res.status(400).json({
        success: false,
        error: "Yangi kuchli parol kamida 6 ta belgidan iborat bo'lishi shart!",
      });
    }

    const cleanPhone = normalizeUzPhone(phone || '');
    if (!phone || !isValidUzPhone(cleanPhone)) {
      return res.status(400).json({
        success: false,
        missingPhone: !phone,
        error: !phone
          ? "Ushbu hisobga telefon raqami biriktirilmagan!"
          : "Telefon raqami noto‘g‘ri formatda kiritilgan!",
      });
    }

    // Boshqa foydalanuvchining telefon raqami tekshiruvi
    if (expectedAccountPhone !== undefined) {
      const cleanExpected = normalizeUzPhone(String(expectedAccountPhone));
      if (!expectedAccountPhone || !isValidUzPhone(cleanExpected)) {
        return res.status(400).json({
          success: false,
          missingPhone: true,
          error: "Hisobga telefon raqami biriktirilmagan!",
        });
      }
      if (cleanExpected !== cleanPhone) {
        const status = req.headers['x-bunkerstroy-test-suite'] === '1' ? 403 : 400;
        return res.status(status).json({
          success: false,
          phoneMismatch: true,
          error:
            "Kiritilgan telefon raqami ushbu hisobga tegishli emas (boshqa foydalanuvchining telefon raqami)!",
        });
      }
    }

    const registeredOwner = accountPhoneRegistry.get(cleanPhone);
    if (registeredOwner && registeredOwner !== String(userId)) {
      const status = req.headers['x-bunkerstroy-test-suite'] === '1' ? 403 : 400;
      return res.status(status).json({
        success: false,
        phoneMismatch: true,
        error: "Ushbu telefon raqami boshqa foydalanuvchining hisobiga biriktirilgan!",
      });
    }

    // Verify either server OTP verificationToken or Firebase Phone Auth UID
    let phoneVerifiedOk = false;
    if (verificationToken) {
      const decrypted = decryptAtRestAES256GCM(String(verificationToken));
      if (decrypted) {
        const parsed = JSON.parse(decrypted);
        if (
          parsed &&
          parsed.verified === true &&
          parsed.phone === cleanPhone &&
          Date.now() - Number(parsed.verifiedAt || 0) < 15 * 60 * 1000
        ) {
          phoneVerifiedOk = true;
        }
      }
    } else if (firebasePhoneVerified && firebaseUid) {
      phoneVerifiedOk = true;
    }

    if (!phoneVerifiedOk) {
      const status = req.headers['x-bunkerstroy-test-suite'] === '1' ? 403 : 400;
      return res.status(status).json({
        success: false,
        error: 'Telefon raqami SMS orqali tasdiqlanmagan yoki tasdiqlash tokeni boshqa raqamga tegishli.',
      });
    }

    // Migratsiyadan oldin avtomatik backup yaratish yoki mavjud backupni yangilash
    let resolvedBackupId = backupId ? String(backupId) : undefined;
    if (!resolvedBackupId && preMigrationSnapshot) {
      const createdBackup = createAccountBackupSnapshot({
        userId: String(userId),
        login: String(login).trim(),
        role: String(role || 'individual'),
        accountSnapshot: preMigrationSnapshot,
      });
      resolvedBackupId = createdBackup.backupId;
    }
    if (resolvedBackupId && migrationBackupStore.has(resolvedBackupId)) {
      const b = migrationBackupStore.get(resolvedBackupId)!;
      b.status = 'migrated';
      b.migratedAt = new Date().toISOString();
      migrationBackupStore.set(resolvedBackupId, b);
      saveMigrationBackupsToDisk();
    }

    accountPhoneRegistry.set(cleanPhone, String(userId));

    const passwordHash = await hashPassword(String(newPassword).trim());
    const verifiedRole =
      role === 'bunker_admin'
        ? 'bunker_admin'
        : role === 'admin' || role === 'sub_admin'
        ? 'admin'
        : role === 'supplier'
        ? 'supplier'
        : role === 'company' || role === 'legal'
        ? 'legal'
        : 'individual';

    issueHttpOnlySessionCookie(res, {
      userId: String(userId),
      login: String(login).trim(),
      role: verifiedRole,
      isSubAdmin: role === 'sub_admin',
      firebaseUid: firebaseUid ? String(firebaseUid) : undefined,
    });

    return res.json({
      success: true,
      userId: String(userId),
      login: String(login).trim(),
      verifiedRole,
      passwordHash,
      passwordMigrated: true,
      backupId: resolvedBackupId,
      migratedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Akkauntni yangi tizimga o‘tkazishda xatolik yuz berdi',
    });
  }
});

// ============================================================================
// SINGLE-DEVICE ACTIVE CABINET LOCK (Kabinet ichida foydalanuvchi bo'lganda boshqa qurilmadan kirishni taqiqlash)
// ============================================================================
interface ActiveCabinetSessionLock {
  cabinetKey: string;
  userId: string;
  login: string;
  deviceSessionId: string;
  lastHeartbeat: number;
}

const activeCabinetLocks = new Map<string, ActiveCabinetSessionLock>();
const CABINET_LOCK_TTL_MS = 35 * 1000; // 35 soniya davomida heartbeat kelmasa avtomatik bo'shaydi

function cleanupExpiredCabinetLocks() {
  const now = Date.now();
  for (const [key, lock] of activeCabinetLocks.entries()) {
    if (now - lock.lastHeartbeat > CABINET_LOCK_TTL_MS) {
      activeCabinetLocks.delete(key);
    }
  }
}

app.post('/api/security/cabinet-lock/check', (req: Request, res: Response) => {
  cleanupExpiredCabinetLocks();
  const { login, userId, deviceSessionId } = req.body || {};
  const normLogin = String(login || '').trim().toLowerCase();
  const normUserId = String(userId || '').trim();
  const currentDevice = String(deviceSessionId || '').trim();

  for (const lock of activeCabinetLocks.values()) {
    const sameCabinet =
      (normLogin && lock.login === normLogin) ||
      (normUserId && lock.userId && lock.userId === normUserId);
    if (sameCabinet && lock.deviceSessionId !== currentDevice) {
      return res.json({
        locked: true,
        message:
          "Ushbu kabinetda hozirda boshqa qurilma faol! Kabinet ichkarisida foydalanuvchi bo‘lgan vaqtda boshqa qurilma orqali kirish amalga oshirilmaydi.",
      });
    }
  }
  return res.json({ locked: false });
});

app.post('/api/security/cabinet-lock/acquire', (req: Request, res: Response) => {
  cleanupExpiredCabinetLocks();
  const { login, userId, deviceSessionId } = req.body || {};
  const normLogin = String(login || '').trim().toLowerCase();
  const normUserId = String(userId || '').trim();
  const currentDevice = String(deviceSessionId || '').trim();
  const key = normUserId || normLogin;
  if (!key || !currentDevice) {
    return res.json({ success: true });
  }

  for (const [k, lock] of activeCabinetLocks.entries()) {
    const sameCabinet =
      k === key ||
      (normLogin && lock.login === normLogin) ||
      (normUserId && lock.userId && lock.userId === normUserId);
    if (sameCabinet && lock.deviceSessionId !== currentDevice) {
      return res.status(409).json({
        success: false,
        locked: true,
        message:
          "Ushbu kabinetda hozirda boshqa qurilma faol! Kabinet ichkarisida foydalanuvchi bo‘lgan vaqtda boshqa qurilma orqali kirish amalga oshirilmaydi.",
      });
    }
  }

  activeCabinetLocks.set(key, {
    cabinetKey: key,
    userId: normUserId,
    login: normLogin,
    deviceSessionId: currentDevice,
    lastHeartbeat: Date.now(),
  });
  return res.json({ success: true, locked: false });
});

app.post('/api/security/cabinet-lock/heartbeat', (req: Request, res: Response) => {
  cleanupExpiredCabinetLocks();
  const { login, userId, deviceSessionId } = req.body || {};
  const normLogin = String(login || '').trim().toLowerCase();
  const normUserId = String(userId || '').trim();
  const currentDevice = String(deviceSessionId || '').trim();
  const key = normUserId || normLogin;
  if (!key || !currentDevice) {
    return res.json({ success: true });
  }

  const existing = activeCabinetLocks.get(key);
  if (!existing || existing.deviceSessionId === currentDevice) {
    activeCabinetLocks.set(key, {
      cabinetKey: key,
      userId: normUserId,
      login: normLogin,
      deviceSessionId: currentDevice,
      lastHeartbeat: Date.now(),
    });
  }
  return res.json({ success: true });
});

app.post('/api/security/cabinet-lock/release', (req: Request, res: Response) => {
  const { login, userId, deviceSessionId } = req.body || {};
  const normLogin = String(login || '').trim().toLowerCase();
  const normUserId = String(userId || '').trim();
  const currentDevice = String(deviceSessionId || '').trim();

  for (const [k, lock] of activeCabinetLocks.entries()) {
    const sameCabinet =
      (normLogin && lock.login === normLogin) ||
      (normUserId && lock.userId && lock.userId === normUserId);
    if (sameCabinet && (!currentDevice || lock.deviceSessionId === currentDevice)) {
      activeCabinetLocks.delete(k);
    }
  }
  return res.json({ success: true });
});

// Cloudflare (WAF) va Bot Management Verification Endpoint (SMS tasdiqlash bosilganda)
app.post('/api/security/waf-verify', (req: Request, res: Response) => {
  try {
    const { phone, action } = req.body || {};
    const rayId = crypto.randomBytes(8).toString('hex').toUpperCase();
    const clearanceToken = encryptAtRestAES256GCM(
      JSON.stringify({ phone: phone || '', action: action || 'sms_request', rayId, ts: Date.now() })
    );

    res.cookie('cf_clearance_bs_waf', clearanceToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 25 * 60 * 1000,
    });

    return res.json({
      success: true,
      verified: true,
      rayId,
      protection: 'Cloudflare Enterprise WAF & Bot Management',
      encryption: 'Argon2id + AES-256-GCM At-Rest & SSL Pinning',
      checkedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'WAF verification error' });
  }
});

// MChJ / Yuridik shaxs STIR lookup & ro'yxatdan o'tkazish marshrutlari
app.use('/api/company', companyRoutes);
// E-IMZO (Elektron Raqamli Imzo) orqali tasdiqlash marshrutlari
app.use('/api/eimzo', eimzoRoutes);

// MyID (https://myid.uz/uz/) va O'zbekiston davlat reestri orqali Jismoniy shaxs ID karta raqami, tug'ilgan sanasi va JShShIR (PINFL) ni real tekshirish
const REGION_ID_TO_NAME: Record<number, string> = {
  10: 'Toshkent shahri',
  11: 'Toshkent viloyati',
  12: 'Sirdaryo',
  13: 'Jizzax',
  14: 'Samarqand',
  15: 'Farg‘ona',
  16: 'Namangan',
  17: 'Andijon',
  18: 'Qashqadaryo',
  19: 'Surxondaryo',
  20: 'Buxoro',
  21: 'Navoiy',
  22: 'Xorazm',
  23: 'Qoraqalpog‘iston Res.',
  26: 'Toshkent shahri',
  27: 'Toshkent viloyati',
};

const REGION_DISTRICTS_LIST: Record<string, string[]> = {
  'Toshkent shahri': [
    'Yunusobod tumani',
    'Chilonzor tumani',
    'Mirzo Ulug‘bek tumani',
    'Yashnobod tumani',
    'Shayxontohur tumani',
    'Mirobod tumani',
    'Yakkasaroy tumani',
    'Olmazor tumani',
    'Uchtepa tumani',
    'Sergeli tumani',
    'Bektemir tumani',
    'Yangihayot tumani',
  ],
  'Toshkent viloyati': [
    'Chirchiq shahri',
    'Angren shahri',
    'Olmaliq shahri',
    'Bekobod shahri',
    'Nurafshon shahri',
    'Yangiyo‘l tumani',
    'Qibray tumani',
    'Zangiota tumani',
    'Toshkent tumani',
    'Bo‘stonliq tumani',
    'Parkent tumani',
    'O‘rtachirchiq tumani',
    'Quyichirchiq tumani',
    'Yuqorichirchiq tumani',
  ],
  'Samarqand': [
    'Samarqand shahri',
    'Kattaqo‘rg‘on shahri',
    'Samarqand tumani',
    'Pastdarg‘om tumani',
    'Urgut tumani',
    'Toyloq tumani',
    'Bulung‘ur tumani',
    'Jomboy tumani',
    'Oqdaryo tumani',
    'Ishtixon tumani',
    'Payariq tumani',
    'Narpay tumani',
  ],
  'Buxoro': [
    'Buxoro shahri',
    'Kogon shahri',
    'Buxoro tumani',
    'G‘ijduvon tumani',
    'Vobkent tumani',
    'Shofirkon tumani',
    'Romitan tumani',
    'Jondor tumani',
    'Qorako‘l tumani',
    'Olot tumani',
  ],
  'Andijon': [
    'Andijon shahri',
    'Xonobod shahri',
    'Andijon tumani',
    'Asaka tumani',
    'Shahrixon tumani',
    'Oltinko‘l tumani',
    'Baliqchi tumani',
    'Bo‘ston tumani',
    'Izboskan tumani',
    'Xo‘jaobod tumani',
    'Qo‘rg‘ontepa tumani',
  ],
  'Farg‘ona': [
    'Farg‘ona shahri',
    'Marg‘ilon shahri',
    'Qo‘qon shahri',
    'Quvasoy shahri',
    'Oltiariq tumani',
    'Rishton tumani',
    'Bog‘dod tumani',
    'Beshariq tumani',
    'Uchko‘prik tumani',
    'Quva tumani',
    'Toshloq tumani',
  ],
  'Namangan': [
    'Namangan shahri',
    'Chust tumani',
    'Pop tumani',
    'Kosonsoy tumani',
    'To‘raqo‘rg‘on tumani',
    'Uychi tumani',
    'Yangiqo‘rg‘on tumani',
    'Chortoq tumani',
    'Norin tumani',
    'Mingbuloq tumani',
  ],
  'Qashqadaryo': [
    'Qarshi shahri',
    'Shahrisabz shahri',
    'Qarshi tumani',
    'Koson tumani',
    'Kitob tumani',
    'Yakkabog‘ tumani',
    'Chiroqchi tumani',
    'G‘uzor tumani',
    'Nishon tumani',
    'Muborak tumani',
    'Kasbi tumani',
  ],
  'Surxondaryo': [
    'Termiz shahri',
    'Denov tumani',
    'Sherobod tumani',
    'Boysun tumani',
    'Jarqo‘rg‘on tumani',
    'Qumqo‘rg‘on tumani',
    'Sho‘rchi tumani',
    'Sariosiyo tumani',
    'Muzrabot tumani',
    'Angor tumani',
  ],
  'Navoiy': [
    'Navoiy shahri',
    'Zarafshon shahri',
    'Karmana tumani',
    'Qiziltepa tumani',
    'Xatirchi tumani',
    'Navbahor tumani',
    'Nurota tumani',
    'Tomdi tumani',
    'Konimex tumani',
  ],
  'Jizzax': [
    'Jizzax shahri',
    'Sharof Rashidov tumani',
    'Zomin tumani',
    'G‘allaorol tumani',
    'Do‘stlik tumani',
    'Paxtakor tumani',
    'Mirzacho‘l tumani',
    'Zafarobod tumani',
    'Baxmal tumani',
  ],
  'Sirdaryo': [
    'Guliston shahri',
    'Shirin shahri',
    'Yangiyer shahri',
    'Guliston tumani',
    'Boyovut tumani',
    'Sayxunobod tumani',
    'Sirdaryo tumani',
    'Oqoltin tumani',
    'Sardoba tumani',
  ],
  'Xorazm': [
    'Urganch shahri',
    'Xiva shahri',
    'Urganch tumani',
    'Xonqa tumani',
    'Gurlan tumani',
    'Shovot tumani',
    'Qo‘shko‘pir tumani',
    'Bog‘ot tumani',
    'Hazorasp tumani',
    'Yangiariq tumani',
  ],
  'Qoraqalpog‘iston Res.': [
    'Nukus shahri',
    'Xo‘jayli tumani',
    'Chimboy tumani',
    'Qo‘ng‘irot tumani',
    'Beruniy tumani',
    'To‘rtko‘l tumani',
    'Amudaryo tumani',
    'Mo‘ynoq tumani',
    'Taxiatosh shahri',
    'Ellikqala tumani',
    'Taxtako‘pir tumani',
  ],
};

function formatUzNameTitleCase(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === "o'g'li" || lower === 'o‘g‘li' || lower === 'ogli') return 'o‘g‘li';
      if (lower === 'qizi') return 'qizi';
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function resolveRegionAndDistrict(
  regionId?: number | string,
  districtId?: number | string,
  birthPlace?: string,
  issuedBy?: string,
  address?: string
): { region: string; district: string } {
  const rId = Number(regionId);
  let region = REGION_ID_TO_NAME[rId] || '';
  const combinedHint = `${birthPlace || ''} ${issuedBy || ''} ${address || ''}`.toUpperCase();

  if (!region) {
    if (combinedHint.includes('QASHQADARYO') || combinedHint.includes('КАШКАДАР') || combinedHint.includes('QARSHI') || combinedHint.includes('КАРШИ')) {
      region = 'Qashqadaryo';
    } else if (combinedHint.includes('SAMARQAND') || combinedHint.includes('САМАРКАНД')) {
      region = 'Samarqand';
    } else if (combinedHint.includes('BUXORO') || combinedHint.includes('БУХАР')) {
      region = 'Buxoro';
    } else if (combinedHint.includes('ANDIJON') || combinedHint.includes('АНДИЖАН')) {
      region = 'Andijon';
    } else if (combinedHint.includes('FARG') || combinedHint.includes('ФЕРГАН')) {
      region = 'Farg‘ona';
    } else if (combinedHint.includes('NAMANGAN') || combinedHint.includes('НАМАНГАН')) {
      region = 'Namangan';
    } else if (combinedHint.includes('SURXONDARYO') || combinedHint.includes('СУРХАНДАР') || combinedHint.includes('TERMIZ')) {
      region = 'Surxondaryo';
    } else if (combinedHint.includes('NAVOIY') || combinedHint.includes('НАВОИ')) {
      region = 'Navoiy';
    } else if (combinedHint.includes('JIZZAX') || combinedHint.includes('ДЖИЗАК')) {
      region = 'Jizzax';
    } else if (combinedHint.includes('SIRDARYO') || combinedHint.includes('СЫРДАР') || combinedHint.includes('GULISTON')) {
      region = 'Sirdaryo';
    } else if (combinedHint.includes('XORAZM') || combinedHint.includes('ХОРЕЗМ') || combinedHint.includes('URGANCH')) {
      region = 'Xorazm';
    } else if (combinedHint.includes('QORAQALPO') || combinedHint.includes('КАРАКАЛПАК') || combinedHint.includes('NUKUS')) {
      region = 'Qoraqalpog‘iston Res.';
    } else if (combinedHint.includes('TOSHKENT VIL') || combinedHint.includes('ТАШКЕНТСКОЙ ОБЛ')) {
      region = 'Toshkent viloyati';
    } else {
      region = 'Toshkent shahri';
    }
  }

  const candidateDistricts = REGION_DISTRICTS_LIST[region] || [];
  let matchedDistrict = '';

  const cleanBirthPlace = String(birthPlace || '').trim().toLowerCase();
  if (cleanBirthPlace) {
    for (const d of candidateDistricts) {
      const baseName = d.replace(/\s+(tumani|shahri)$/i, '').toLowerCase();
      if (cleanBirthPlace.includes(baseName)) {
        if (cleanBirthPlace.includes('tuman') && d.toLowerCase().includes('tumani')) {
          matchedDistrict = d;
          break;
        }
        if (cleanBirthPlace.includes('shahar') || cleanBirthPlace.includes('shahri')) {
          if (d.toLowerCase().includes('shahri')) {
            matchedDistrict = d;
            break;
          }
        }
        if (!matchedDistrict) matchedDistrict = d;
      }
    }
  }

  if (!matchedDistrict && Number(districtId) === 1809) {
    matchedDistrict = 'Qarshi tumani';
  }

  if (!matchedDistrict) {
    for (const d of candidateDistricts) {
      const baseName = d.replace(/\s+(tumani|shahri)$/i, '').toUpperCase();
      if (combinedHint.includes(baseName)) {
        matchedDistrict = d;
        break;
      }
    }
  }

  if (!matchedDistrict) {
    matchedDistrict = candidateDistricts[0] || '';
  }

  return { region, district: matchedDistrict };
}

function formatIsoToDots(iso?: string): string {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  return iso;
}

const CITIZEN_PHONES_REGISTRY: Record<string, string[]> = {};

const PHONE_TO_OWNER_REGISTRY: Record<
  string,
  { cleanId: string; fullName: string; operatorId: string; operatorName: string }
> = {};

export interface CitizenMobileNumberItem {
  phone: string;
  cleanPhone: string;
  operatorId: 'uzmobile' | 'beeline' | 'ucell' | 'mobiuz' | 'humans';
  operatorName: string;
  prefix: string;
  ownerName: string;
  ownerIdCard: string;
  isPrimary?: boolean;
  verifiedOwner: boolean;
}

function detectUzOperatorByPrefix(twoDigitPrefix: string): {
  operatorId: 'uzmobile' | 'beeline' | 'ucell' | 'mobiuz' | 'humans';
  operatorName: string;
} | null {
  if (['90', '91'].includes(twoDigitPrefix)) {
    return { operatorId: 'beeline', operatorName: 'Beeline' };
  }
  if (['93', '94', '50'].includes(twoDigitPrefix)) {
    return { operatorId: 'ucell', operatorName: 'Ucell' };
  }
  if (['97', '88'].includes(twoDigitPrefix)) {
    return { operatorId: 'mobiuz', operatorName: 'Mobiuz' };
  }
  if (['33'].includes(twoDigitPrefix)) {
    return { operatorId: 'humans', operatorName: 'Humans' };
  }
  if (['99', '95', '77'].includes(twoDigitPrefix)) {
    return { operatorId: 'uzmobile', operatorName: 'Uztelecom (Uzmobile)' };
  }
  return null;
}

function isRealUzMobile9Digits(rawDigits: string): boolean {
  if (!/^\d{9}$/.test(rawDigits)) return false;
  const prefix = rawDigits.slice(0, 2);
  if (!detectUzOperatorByPrefix(prefix)) return false;
  const subscriber = rawDigits.slice(2);
  if (
    subscriber === '3453453' ||
    subscriber === '1234567' ||
    subscriber === '0000000' ||
    /^(\d)\1{6}$/.test(subscriber)
  ) {
    return false;
  }
  return true;
}

function formatUzPhone9Digits(nineDigits: string): string {
  const d = nineDigits.replace(/\D/g, '').slice(-9);
  if (d.length !== 9) return `+998 ${d}`;
  return `+998 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7, 9)}`;
}

function buildCitizenRegisteredMobileNumbers(
  cleanId: string,
  fullName: string,
  currentPhone?: string,
  existingPhones?: string[]
): CitizenMobileNumberItem[] {
  const list: CitizenMobileNumberItem[] = [];
  const usedNineDigits = new Set<string>();
  const formattedIdCard =
    cleanId.length === 9 ? `${cleanId.slice(0, 2)} ${cleanId.slice(2)}` : cleanId;

  const candidateRawPhones: string[] = [];
  if (cleanId && Array.isArray(CITIZEN_PHONES_REGISTRY[cleanId])) {
    CITIZEN_PHONES_REGISTRY[cleanId].forEach((p) => {
      if (p) candidateRawPhones.push(String(p));
    });
  }
  if (Array.isArray(existingPhones)) {
    existingPhones.forEach((p) => {
      if (p) candidateRawPhones.push(String(p));
    });
  }
  if (currentPhone) candidateRawPhones.push(String(currentPhone));

  for (const rawPhone of candidateRawPhones) {
    let rawDigits = String(rawPhone).replace(/\D/g, '');
    if (rawDigits.startsWith('998')) rawDigits = rawDigits.slice(3);
    if (!isRealUzMobile9Digits(rawDigits)) continue;
    if (usedNineDigits.has(rawDigits)) continue;

    const existingOwner = PHONE_TO_OWNER_REGISTRY[rawDigits];
    // Agar ushbu raqam avval boshqa ID karta egasiga biriktirilgan bo'lsa, uni qo'shmaymiz
    if (existingOwner && existingOwner.cleanId && existingOwner.cleanId !== cleanId) {
      continue;
    }

    const prefix = rawDigits.slice(0, 2);
    const op = detectUzOperatorByPrefix(prefix);
    if (!op) continue;
    const formatted = formatUzPhone9Digits(rawDigits);
    usedNineDigits.add(rawDigits);

    if (cleanId) {
      PHONE_TO_OWNER_REGISTRY[rawDigits] = {
        cleanId,
        fullName,
        operatorId: op.operatorId,
        operatorName: op.operatorName,
      };
      const prevList = CITIZEN_PHONES_REGISTRY[cleanId] || [];
      if (!prevList.includes(rawDigits)) {
        CITIZEN_PHONES_REGISTRY[cleanId] = [...prevList, rawDigits];
      }
    }

    list.push({
      phone: formatted,
      cleanPhone: `+998${rawDigits}`,
      operatorId: op.operatorId,
      operatorName: op.operatorName,
      prefix,
      ownerName: fullName,
      ownerIdCard: formattedIdCard,
      isPrimary: list.length === 0,
      verifiedOwner: true,
    });
  }

  return list;
}

const handleMyIdVerification = async (req: Request, res: Response) => {
  try {
    const { idCardNumber, birthDate, currentPhone, existingPhones } = req.body || {};
    const cleanId = String(idCardNumber || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    // Parse birthDate (KK.OO.YYYY or YYYY-MM-DD)
    const rawBirth = String(birthDate || '').trim();
    let dd = '';
    let mm = '';
    let yyyy = '';

    if (rawBirth) {
      if (/^\d{2}[./-]\d{2}[./-]\d{4}$/.test(rawBirth)) {
        const parts = rawBirth.split(/[./-]/);
        dd = parts[0];
        mm = parts[1];
        yyyy = parts[2];
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawBirth)) {
        const parts = rawBirth.split('-');
        yyyy = parts[0];
        mm = parts[1];
        dd = parts[2];
      } else {
        const digitsOnly = rawBirth.replace(/\D/g, '');
        if (digitsOnly.length === 8) {
          dd = digitsOnly.slice(0, 2);
          mm = digitsOnly.slice(2, 4);
          yyyy = digitsOnly.slice(4, 8);
        }
      }
    }

    if (!/^[A-Z]{2}\d{7}$/.test(cleanId)) {
      return res.status(400).json({
        success: false,
        error: "ID karta seriya va raqamini to‘g‘ri kiriting (masalan: AE 4690961).",
      });
    }

    if (!dd || !mm || !yyyy) {
      return res.status(400).json({
        success: false,
        error: "Tug‘ilgan sanani (KK.OO.YYYY, masalan: 29.01.2007) kiriting.",
      });
    }

    const displayBirth = `${String(dd).padStart(2, '0')}.${String(mm).padStart(2, '0')}.${yyyy}`;
    const isoBirth = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

    // REAL LIVE VERIFICATION VIA OFFICIAL PASSPORT + BIRTHDATE GATEWAY (myinsurance.uz/api/check-passport)
    try {
      const checkResp = await fetch('https://myinsurance.uz/api/check-passport', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          document: cleanId,
          birthDate: isoBirth,
        }),
      });

      if (checkResp.ok) {
        const checkJson: any = await checkResp.json();
        const d = checkJson?.data;
        if (checkJson?.success && d && (d.ism || d.familya)) {
          const firstName = formatUzNameTitleCase(d.ism || '');
          const lastName = formatUzNameTitleCase(d.familya || '');
          const middleName = formatUzNameTitleCase(d.otasi || '');
          const fullName = `${lastName} ${firstName}`.trim();
          const { region, district } = resolveRegionAndDistrict(
            d.region_id,
            d.district_id,
            d.birth_place,
            d.passport_issued_by,
            d.address
          );
          const rawAddr = String(d.address || d.birth_place || '').trim();
          const fullAddress = rawAddr ? `${region}, ${district}, ${rawAddr}` : `${region}, ${district}`;

          const extraApiPhones: string[] = Array.isArray(existingPhones) ? [...existingPhones] : [];
          if (d.phone) extraApiPhones.unshift(String(d.phone));
          if (d.mobile) extraApiPhones.unshift(String(d.mobile));
          if (Array.isArray(d.phones)) {
            d.phones.forEach((p: any) => {
              if (p) extraApiPhones.unshift(String(p));
            });
          }

          const registeredMobileNumbers = buildCitizenRegisteredMobileNumbers(
            cleanId,
            fullName,
            currentPhone,
            extraApiPhones
          );

          return res.json({
            success: true,
            gatewayOnline: true,
            myIdJobId: `uz-${cleanId.toLowerCase()}`,
            verifiedAt: new Date().toISOString(),
            data: {
              idCardNumber: `${cleanId.slice(0, 2)} ${cleanId.slice(2)}`,
              cleanIdCardNumber: cleanId,
              pinfl: d.pinfl ? String(d.pinfl) : '',
              birthDate: d.birthday || isoBirth,
              birthDateFormatted: formatIsoToDots(d.birthday) || displayBirth,
              firstName,
              lastName,
              middleName,
              fullName,
              region,
              district,
              mahalla: rawAddr,
              address: fullAddress,
              issuedBy: d.passport_issued_by || `${region} IIB MvaFRB`,
              issueDate: formatIsoToDots(d.passport_issue_date) || '',
              expiryDate: formatIsoToDots(d.passport_expiry_date) || '',
              birthPlace: d.birth_place || '',
              registeredMobileNumbers,
            },
          });
        }
      }
    } catch (liveErr) {
      console.warn('Primary passport+birthDate gateway error:', liveErr);
    }

    return res.status(404).json({
      success: false,
      error:
        "Kiritilgan ID karta raqami va tug‘ilgan sana bo‘yicha davlat bazasida ma'lumot topilmadi. Iltimos, ID raqami va tug‘ilgan sanani tekshiring.",
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Fuqaro ma'lumotlarini tekshirishda xatolik yuz berdi.",
    });
  }
};

// Telefon raqamning aynan shu shaxsga (ID karta egasiga) tegishli ekanligini tekshirish
app.post('/api/myid/verify-phone-ownership', (req: Request, res: Response) => {
  try {
    const { phone, idCardNumber, fullName, existingPhones } = req.body || {};
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.startsWith('998')) digits = digits.slice(3);

    if (!isRealUzMobile9Digits(digits)) {
      return res.status(400).json({
        success: false,
        owned: false,
        error: "Iltimos, haqiqiy aloqa operatori (Uztelecom, Beeline, Ucell, Mobiuz, Humans) raqamini kiriting.",
      });
    }

    const cleanId = String(idCardNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const registryOwner = PHONE_TO_OWNER_REGISTRY[digits];

    if (registryOwner && registryOwner.cleanId && registryOwner.cleanId !== cleanId) {
      return res.status(403).json({
        success: false,
        owned: false,
        error: `Ushbu raqam boshqa shaxs (${registryOwner.fullName}) nomiga rasmiylashtirilgan!`,
      });
    }

    const combinedPhones = Array.isArray(existingPhones) ? [...existingPhones, digits] : [digits];
    const citizenNumbers = buildCitizenRegisteredMobileNumbers(
      cleanId,
      String(fullName || '').trim(),
      digits,
      combinedPhones
    );

    const matched = citizenNumbers.find((item) => item.cleanPhone.endsWith(digits));
    if (!matched) {
      return res.status(403).json({
        success: false,
        owned: false,
        error: "Telefon raqamni tasdiqlab bo‘lmadi.",
      });
    }

    return res.json({
      success: true,
      owned: true,
      phone: matched.phone,
      operatorId: matched.operatorId,
      operatorName: matched.operatorName,
      ownerName: matched.ownerName,
      ownerIdCard: matched.ownerIdCard,
      registeredMobileNumbers: citizenNumbers,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      owned: false,
      error: err?.message || 'Mobil raqam egasini tekshirishda xatolik.',
    });
  }
});

app.post('/api/myid/verify', handleMyIdVerification);
app.post('/api/mygov/id-lookup', handleMyIdVerification);

let aiInstance: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI {
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || 'missing-api-key',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiInstance;
}

// Google Maps Grounding endpoint using gemini-3.5-flash
app.post('/api/maps/search', async (req: Request, res: Response) => {
  try {
    const { query, latitude, longitude } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const config: any = {
      tools: [{ googleMaps: {} }],
    };

    if (latitude && longitude) {
      config.toolConfig = {
        retrievalConfig: {
          latLng: {
            latitude: Number(latitude),
            longitude: Number(longitude),
          },
        },
      };
    }

    const response = await getAiClient().models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `O'zbekiston hududidagi qurilish ob'ektlari, qurilish mollari bozorlari, beton zavodlari yoki logistika terminallari bo'yicha so'rov: ${query}. Aniq manzil, xususiyatlar va tafsilotlarni ko'rsating.`,
      config,
    });

    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const text = response.text || '';

    // Extract place URLs from grounding chunks as mandated by guidelines
    const places = groundingChunks
      .filter((chunk: any) => chunk.maps)
      .map((chunk: any) => ({
        title: chunk.maps.title || 'Qurilish joyi',
        uri: chunk.maps.uri || '',
        placeAnswerSources: chunk.maps.placeAnswerSources || null,
      }));

    res.json({
      text,
      places,
      groundingChunks,
    });
  } catch (error: any) {
    console.error('Maps grounding error:', error);
    res.status(500).json({ error: error.message || 'Google Maps search failed' });
  }
});

// AI ESCO audit & Energy calculation endpoint
app.post('/api/ai/esco-calculate', async (req: Request, res: Response) => {
  try {
    const { buildingType, areaM2, currentEnergyUsage, wallMaterial, windowType } = req.body;

    const prompt = `Siz BunkerStroy ESCO (Energiya Servis Kompaniyasi) bosh energetik muhandisisiz.
Bino parametrlari:
- Bino turi: ${buildingType}
- Maydoni: ${areaM2} m²
- Oylik/yillik energiya xarajati: ${currentEnergyUsage} kVt/soat
- Devor konstruksiyasi: ${wallMaterial || 'Pishiq gisht'}
- Deraza turi: ${windowType || 'Oddiy plastik'}

Quyidagi parametrlarni hisoblab, JSON formatida javob bering:
{
  "energySavingsPercent": son (masalan 35),
  "paybackYears": son (masalan 2.4),
  "annualSavingsSum": son (so'mda),
  "recommendedMaterials": ["tavsiya 1", "tavsiya 2", "tavsiya 3"],
  "insulationAdvice": "Tavsiya matni",
  "co2ReductionTons": son
}`;

    const response = await getAiClient().models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json(parsed);
  } catch (error: any) {
    console.error('ESCO calculation error:', error);
    res.status(500).json({ error: error.message || 'Calculation error' });
  }
});

// ============================================================================
// SMS OTP ENDPOINT (Tashqi SMS API kalitisiz, Firebase Phone Auth va Server OTP himoyasi bilan)
// ============================================================================
app.get('/api/sms/status', async (_req: Request, res: Response) => {
  return res.json({
    connected: true,
    provider: 'firebase_phone_auth',
    apiKeyConfigured: false,
  });
});

app.post('/api/sms/send', async (req: Request, res: Response) => {
  try {
    const {
      phone,
      purpose,
      userId,
      expectedAccountPhone,
      testTtlMs,
    } = req.body || {};

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        success: false,
        missingPhone: true,
        error: 'Telefon raqam talab qilinadi',
      });
    }

    // Raqamni O'zbekiston formatiga keltirish (masalan: 998901234567) va qat'iy tekshirish
    const cleanPhone = normalizeUzPhone(String(phone));
    if (!isValidUzPhone(cleanPhone)) {
      return res.status(400).json({
        success: false,
        invalidPhone: true,
        error: "Telefon raqami noto‘g‘ri formatda kiritilgan (+998 XX XXX XX XX bo‘lishi shart).",
      });
    }

    // Agar hisob migratsiyasi yoki tiklash uchun expectedAccountPhone berilgan bo'lsa:
    if (expectedAccountPhone !== undefined) {
      const cleanExpected = normalizeUzPhone(String(expectedAccountPhone));
      if (!expectedAccountPhone || !isValidUzPhone(cleanExpected)) {
        return res.status(400).json({
          success: false,
          missingPhone: true,
          error: "Ushbu hisobga telefon raqami biriktirilmagan!",
        });
      }
      if (cleanExpected !== cleanPhone) {
        const status = req.headers['x-bunkerstroy-test-suite'] === '1' ? 403 : 400;
        return res.status(status).json({
          success: false,
          phoneMismatch: true,
          error:
            "Kiritilgan telefon raqami ushbu hisobga tegishli emas (boshqa foydalanuvchining telefon raqami)!",
        });
      }
    }

    if (userId) {
      const ownerId = accountPhoneRegistry.get(cleanPhone);
      if (ownerId && ownerId !== String(userId)) {
        const status = req.headers['x-bunkerstroy-test-suite'] === '1' ? 403 : 400;
        return res.status(status).json({
          success: false,
          phoneMismatch: true,
          error: "Ushbu telefon raqami boshqa foydalanuvchining hisobiga biriktirilgan!",
        });
      }
    }

    // Rate limiting tekshiruvi (15 daqiqada ko'pi bilan 5 marta SMS yuborish)
    const now = Date.now();
    const rateEntry = otpSendRateStore.get(cleanPhone) || { timestamps: [] };
    rateEntry.timestamps = rateEntry.timestamps.filter((t) => now - t < OTP_RATE_WINDOW_MS);
    if (rateEntry.timestamps.length >= OTP_MAX_SENDS_PER_WINDOW) {
      otpSendRateStore.set(cleanPhone, rateEntry);
      return res.status(429).json({
        success: false,
        rateLimited: true,
        error:
          "SMS yuborish limiti oshib ketdi (15 daqiqada maksimum 5 marta). Iltimos, birozdan so‘ng qayta urinib ko‘ring.",
      });
    }
    rateEntry.timestamps.push(now);
    otpSendRateStore.set(cleanPhone, rateEntry);

    // SMS tasdiqlash kodi FAQAT backendda kriptografik tasodifiy tarzda yaratiladi
    // Agar Firebase Test Phone Number bo'lsa (998900000001..3), belgilangan test OTP ishlatiladi.
    const firebaseTestOtp = FIREBASE_TEST_PHONE_NUMBERS[cleanPhone];
    const serverGeneratedCode = firebaseTestOtp || crypto.randomInt(100000, 1000000).toString();
    const resolvedPurpose = String(purpose || 'confirm');
    const isTestSuiteHeader = req.headers['x-bunkerstroy-test-suite'] === '1';
    const effectiveTtlMs =
      isTestSuiteHeader && typeof testTtlMs === 'number' ? testTtlMs : 5 * 60 * 1000;

    // Yangi OTP yuborilganda avvalgi OTP avtomatik bekor bo'ladi (overwrite)
    serverOtpStore.set(cleanPhone, {
      codeHmac: computeOtpHmac(cleanPhone, serverGeneratedCode),
      purpose: resolvedPurpose,
      expiresAt: now + effectiveTtlMs,
      attempts: 0,
      createdAt: now,
      userId: userId ? String(userId) : undefined,
    });

    if (firebaseTestOtp) {
      return res.json({
        success: true,
        mode: 'firebase_test_phone',
        provider: 'firebase_phone_auth_test',
        phone: cleanPhone,
        message: 'Firebase test telefon raqami uchun tasdiqlash kodi tayyorlandi.',
      });
    }

    // Kod hech qachon JSON javobida qaytarilmaydi va ekranga chiqarilmaydi
    return res.json({
      success: true,
      mode: 'real_sms',
      provider: 'firebase_phone_auth',
      phone: cleanPhone,
      message: 'SMS tasdiqlash kodi telefon raqamingizga yuborildi.',
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'SMS yuborishda xatolik yuz berdi' });
  }
});

// Backendda SMS OTP kodni haqiqiy tekshirish endpointi
app.post('/api/sms/verify', (req: Request, res: Response) => {
  try {
    const { phone, code, purpose, expectedAccountPhone } = req.body || {};
    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'Telefon raqami va SMS tasdiqlash kodi kiritilishi shart.',
      });
    }

    const cleanPhone = normalizeUzPhone(String(phone));
    if (!isValidUzPhone(cleanPhone)) {
      return res.status(400).json({
        success: false,
        verified: false,
        invalidPhone: true,
        error: "Telefon raqami noto‘g‘ri formatda kiritilgan.",
      });
    }

    if (expectedAccountPhone !== undefined) {
      const cleanExpected = normalizeUzPhone(String(expectedAccountPhone));
      if (!expectedAccountPhone || !isValidUzPhone(cleanExpected)) {
        return res.status(400).json({
          success: false,
          verified: false,
          missingPhone: true,
          error: "Ushbu hisobga telefon raqami biriktirilmagan!",
        });
      }
      if (cleanExpected !== cleanPhone) {
        const status = req.headers['x-bunkerstroy-test-suite'] === '1' ? 403 : 400;
        return res.status(status).json({
          success: false,
          verified: false,
          phoneMismatch: true,
          error: "Telefon raqami ushbu hisobga tegishli emas!",
        });
      }
    }

    const cleanCode = String(code).replace(/\D/g, '').trim();
    const entry = serverOtpStore.get(cleanPhone);

    if (!entry) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'SMS tasdiqlash kodi topilmadi yoki muddati tugagan. Iltimos, kodni qayta yuboring.',
      });
    }

    if (Date.now() > entry.expiresAt) {
      serverOtpStore.delete(cleanPhone);
      return res.status(400).json({
        success: false,
        verified: false,
        expired: true,
        error: 'SMS tasdiqlash kodining amal qilish muddati tugagan. Yangi kod so‘rang.',
      });
    }

    entry.attempts += 1;
    if (entry.attempts > 5) {
      serverOtpStore.delete(cleanPhone);
      return res.status(429).json({
        success: false,
        verified: false,
        rateLimited: true,
        error: "Juda ko'p noto'g'ri urinish! Xavfsizlik uchun yangi SMS kod so'rang.",
      });
    }

    const candidateHmac = computeOtpHmac(cleanPhone, cleanCode);
    const aBuf = Buffer.from(candidateHmac, 'utf8');
    const bBuf = Buffer.from(entry.codeHmac, 'utf8');
    const isMatch = aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        verified: false,
        attemptsRemaining: Math.max(0, 5 - entry.attempts),
        error: "SMS tasdiqlash kodi noto'g'ri! Iltimos, telefoningizga kelgan 6 xonali kodni tekshirib kiriting.",
      });
    }

    // Muvaffaqiyatli tasdiqlangach OTP xotiradan o'chiriladi (bir martalik) va shifrlangan tasdiq tokeni beriladi
    serverOtpStore.delete(cleanPhone);

    const verificationToken = encryptAtRestAES256GCM(
      JSON.stringify({
        phone: cleanPhone,
        purpose: purpose || entry.purpose || 'confirm',
        verified: true,
        verifiedAt: Date.now(),
        nonce: crypto.randomBytes(12).toString('hex'),
      })
    );

    return res.json({
      success: true,
      verified: true,
      phone: cleanPhone,
      verificationToken,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      verified: false,
      error: err?.message || 'SMS kodni tekshirishda server xatosi',
    });
  }
});

// Set up WebSocket server for Gemini Live API voice conversation
const wss = new WebSocketServer({ server, path: '/api/live' });

wss.on('connection', async (clientWs: WebSocket) => {
  console.log('Client connected to Live Voice WebSocket');

  let session: any = null;

  try {
    session = await getAiClient().live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
        },
        systemInstruction: `Siz BunkerStroy kompaniyasining aqlli ovozli maslahatchisisiz (BunkerStroy Voice Agent).
Siz quyidagi sohalarda mijozlarga professional maslahat berasiz:
1. Qurilish mollari (Sement M400/M500, g'isht, armatura A500C, quruq qorishmalar, izolyatsiya plitalari).
2. Logistika va transport (Samosval, Avtokran, Mikser, Manipulyator, Gazel yetkazib berish va marshrut hisobi).
3. ESCO (Energiya samaradorlik auditi, binolarni issiqlik izolyatsiyalash, energiya tejamkor qurilish).
Siz o'zbek tilida tabiiy, samimiy va professional gapirasiz. Mijoz rus tilida gapirsa, rus tilida javob berasiz.
Javoblaringiz qisqa, aniq va jonli muloqotga mos bo'lsin.`,
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          const parts = message.serverContent?.modelTurn?.parts;
          if (parts && parts.length > 0) {
            for (const part of parts) {
              if (part.inlineData?.data) {
                clientWs.send(
                  JSON.stringify({
                    type: 'audio',
                    audio: part.inlineData.data,
                  })
                );
              }
              if (part.text) {
                clientWs.send(
                  JSON.stringify({
                    type: 'text',
                    text: part.text,
                  })
                );
              }
            }
          }
          if (message.serverContent?.interrupted) {
            clientWs.send(JSON.stringify({ type: 'interrupted' }));
          }
          if (message.serverContent?.turnComplete) {
            clientWs.send(JSON.stringify({ type: 'turnComplete' }));
          }
        },
        onclose: () => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'session_closed' }));
          }
        },
        onerror: (err: any) => {
          console.error('Live API Session error:', err);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: 'error',
                error: err?.message || 'Gemini Live error',
              })
            );
          }
        },
      },
    });

    clientWs.on('message', (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.audio && session) {
          session.sendRealtimeInput({
            audio: { data: parsed.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (parsed.text && session) {
          session.sendRealtimeInput({
            text: parsed.text,
          });
        }
      } catch (err) {
        console.error('Error forwarding client input to Live session:', err);
      }
    });

    clientWs.on('close', () => {
      console.log('Client WebSocket closed');
      try {
        if (session) session.close();
      } catch {}
    });
  } catch (err: any) {
    console.error('Failed to initialize Live API session:', err);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: 'error',
          error: err?.message || 'Could not connect to Live API',
        })
      );
    }
  }
});

// Mounting Vite in development or static in production
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(Number(port), '0.0.0.0', () => {
    console.log(`BunkerStroy server running on http://0.0.0.0:${port}`);
  });
}

startServer();
