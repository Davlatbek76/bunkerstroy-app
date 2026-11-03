import assert from 'node:assert/strict';
import { upsertAdmin, getAdminByLogin, updateAdminHash } from '../security/adminStore';
import { hashPassword, verifyPassword } from '../security/passwordHash';

(async () => {
  const h = await hashPassword('Admin-Test-123!');
  await upsertAdmin({ id: 'admin-master', login: 'BOSS', role: 'admin', phone: '+998 71 200 00 50', passwordHash: h });

  const found = await getAdminByLogin('  boss ');
  assert.ok(found);
  assert.equal(found!.role, 'admin');
  assert.equal((await verifyPassword('Admin-Test-123!', found!.passwordHash)).valid, true);
  console.log("OK admin login bo'yicha topildi va parol tekshirildi");

  assert.equal(await getAdminByLogin('yoq-odam'), null);
  console.log("OK mavjud bo'lmagan admin topilmadi");

  const h2 = await hashPassword('Yangi-Parol-456!');
  await updateAdminHash('admin-master', h2);
  const again = await getAdminByLogin('boss');
  assert.equal((await verifyPassword('Admin-Test-123!', again!.passwordHash)).valid, false);
  assert.equal((await verifyPassword('Yangi-Parol-456!', again!.passwordHash)).valid, true);
  console.log("OK parol yangilandi, eskisi ishlamaydi");
  process.exit(0);
})().catch((e) => { console.error('XATO', e); process.exit(1); });
