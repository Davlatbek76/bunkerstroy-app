import { adminDb } from './firebaseAdmin';

export type AdminRole = 'admin' | 'bunker_admin' | 'sub_admin';

export interface ServerAdmin {
  id: string;
  login: string;
  loginLower: string;
  role: AdminRole;
  phone: string;
  passwordHash: string;
  permissions?: string[];
  cabinetName?: string;
  updatedAt: string;
}

const COLLECTION = 'server_admins';

export async function getAdminByLogin(login: string): Promise<ServerAdmin | null> {
  const key = String(login || '').trim().toLowerCase();
  if (!key) return null;
  const snap = await adminDb().collection(COLLECTION).where('loginLower', '==', key).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data() as ServerAdmin;
}

export async function getAdminById(id: string): Promise<ServerAdmin | null> {
  const snap = await adminDb().collection(COLLECTION).doc(String(id || '_')).get();
  return snap.exists ? (snap.data() as ServerAdmin) : null;
}

export async function upsertAdmin(a: Omit<ServerAdmin, 'loginLower' | 'updatedAt'>): Promise<void> {
  const doc: ServerAdmin = {
    ...a,
    loginLower: a.login.trim().toLowerCase(),
    updatedAt: new Date().toISOString(),
  };
  // Firestore undefined qiymatni qabul qilmaydi
  await adminDb().collection(COLLECTION).doc(a.id).set(JSON.parse(JSON.stringify(doc)));
}

export async function updateAdminHash(id: string, passwordHash: string): Promise<void> {
  await adminDb().collection(COLLECTION).doc(id).update({
    passwordHash,
    updatedAt: new Date().toISOString(),
  });
}
