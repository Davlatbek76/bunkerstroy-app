import fs from 'fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

let passed = 0;
let failed = 0;

async function check(name: string, expectDenied: boolean, op: () => Promise<any>) {
  try {
    if (expectDenied) await assertFails(op());
    else await assertSucceeds(op());
    passed++;
    console.log('PASS ' + name);
  } catch {
    failed++;
    console.log('FAIL ' + name + (expectDenied ? '  <-- ZAIFLIK: ruxsat berildi' : '  <-- kerakli amal bloklandi'));
  }
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-bunkerstroy',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });

  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('users/u1').set({ id: 'u1', email: 'a@test.uz', displayName: 'A', role: 'individual', phone: '+998900000001', passwordHash: '$argon2id$test' });
    await db.doc('users/u2').set({ id: 'u2', email: 'b@test.uz', displayName: 'B', role: 'individual', phone: '+998900000002', passwordHash: '$argon2id$test' });
    await db.doc('products/p1').set({ id: 'p1', title: 'Sement', price: 100 });
    await db.doc('orders/o1').set({ id: 'o1', buyerId: 'u1', totalAmount: 1000, status: 'pending', deliveryAddress: 'Toshkent', paymentStatus: 'unpaid', commission: 50 });
    await db.doc('logistics/l1').set({ id: 'l1', orderId: 'o1' });
    await db.doc('esco_audits/e1').set({ id: 'e1', clientId: 'u1', buildingType: 'x', areaM2: 10 });
    await db.doc('cabinet_logs/c1').set({ id: 'c1', action: 'login', actor: 'u1' });
    await db.doc('admins/adm1').set({ ok: true });
  });

  const anon = env.unauthenticatedContext().firestore();
  const u1 = env.authenticatedContext('u1').firestore();
  const u2 = env.authenticatedContext('u2').firestore();
  const adm = env.authenticatedContext('adm1').firestore();


  console.log('\n--- A guruhi: backendga bog\'liq emas, hozir tuzatiladi ---');
  await check('A1 kirmagan odam users hujjatini o\'zgartira olmasin (rol+xesh)', true, () => anon.doc('users/u1').update({ role: 'admin', passwordHash: 'x' }));
  await check('A2 boshqa foydalanuvchi u1 ning rolini o\'zgartira olmasin', true, () => u2.doc('users/u1').update({ role: 'admin' }));
  await check('A3 foydalanuvchi o\'z rolini admin qila olmasin', true, () => u1.doc('users/u1').update({ role: 'admin' }));
  await check('A4 oddiy foydalanuvchi mahsulot yarata olmasin', true, () => u2.doc('products/p2').set({ id: 'p2', title: 'x', price: 1 }));
  await check('A5 oddiy foydalanuvchi mahsulot narxini o\'zgartira olmasin', true, () => u2.doc('products/p1').update({ price: 1 }));
  await check('A6 oddiy foydalanuvchi mahsulotni o\'chira olmasin', true, () => u2.doc('products/p1').delete());
  await check('A7 buyurtma egasi totalAmount ni o\'zgartira olmasin', true, () => u1.doc('orders/o1').update({ totalAmount: 1 }));
  await check('A8 buyurtma egasi paymentStatus ni o\'zgartira olmasin', true, () => u1.doc('orders/o1').update({ paymentStatus: 'paid' }));
  await check('A9 buyurtma egasi commission ni o\'zgartira olmasin', true, () => u1.doc('orders/o1').update({ commission: 0 }));
  await check('A10 kirmagan odam buyurtma yarata olmasin', true, () => anon.doc('orders/o9').set({ id: 'o9', buyerId: 'u1', totalAmount: 1, status: 'pending', deliveryAddress: 'x' }));
  await check('A11 kirmagan odam cabinet_logs yoza olmasin', true, () => anon.doc('cabinet_logs/c9').set({ id: 'c9', action: 'x', actor: 'x' }));
  await check('A12 oddiy foydalanuvchi logistics ni o\'zgartira olmasin', true, () => u2.doc('logistics/l1').update({ orderId: 'hack' }));
  await check('A13 oddiy foydalanuvchi esco_audits ni o\'zgartira olmasin', true, () => u2.doc('esco_audits/e1').update({ areaM2: 1 }));

  console.log('\n--- B guruhi: o\'qish (login backendga o\'tgandan keyin tuzatiladi) ---');
  await check('B1 kirmagan odam users (xesh, telefon) o\'qiy olmasin', true, () => anon.doc('users/u1').get());
  await check('B2 kirmagan odam buyurtmani o\'qiy olmasin', true, () => anon.doc('orders/o1').get());
  await check('B3 kirmagan odam cabinet_logs ni o\'qiy olmasin', true, () => anon.doc('cabinet_logs/c1').get());

  console.log('\n--- L guruhi: ishlashi SHART bo\'lgan haqiqiy amallar ---');
  await check('L1 admin mahsulot narxini o\'zgartira oladi', false, () => adm.doc('products/p1').set({ id: 'p1', title: 'Sement', price: 200 }));
  await check('L2 foydalanuvchi o\'z displayName ini o\'zgartira oladi', false, () => u1.doc('users/u1').update({ displayName: 'Yangi' }));
  await check('L3 mahsulotlarni hamma o\'qiy oladi', false, () => anon.doc('products/p1').get());

  await env.cleanup();
  console.log('\nNATIJA: ' + passed + ' PASS, ' + failed + ' FAIL');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('TEST XATOSI', e); process.exit(2); });
