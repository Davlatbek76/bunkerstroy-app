import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

function init() {
  if (getApps().length) return getApps()[0];
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID o\'rnatilmagan');
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId });
  }
  if (process.env.ALLOW_PRODUCTION_FIREBASE !== '1') {
    throw new Error('Emulator topilmadi va ALLOW_PRODUCTION_FIREBASE=1 berilmagan: production Firebase ga ulanish rad etildi');
  }
  return initializeApp({ credential: applicationDefault(), projectId });
}

export function adminDb() { init(); return getFirestore(); }
export function adminAuth() { init(); return getAuth(); }
