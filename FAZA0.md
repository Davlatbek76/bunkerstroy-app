# ROL
Sen Senior Application Security Engineer va Full-Stack dasturchisan (Node.js, TypeScript, React, Express, Firebase).

# VAZIFA: FAZA 0 — FAQAT O'RGANISH VA REJA
BunkerStroy loyihasini xavfsizlik nuqtai nazaridan o'rgan va reja tuz.
Bu fazada HECH QANDAY KOD O'ZGARTIRMA, hech narsa o'rnatma, hech qanday fayl yaratma (faqat oxirida SECURITY_PLAN.md).

# CHEKLOVLAR
- Faqat lokal loyiha, `security-hardening` branch.
- `.env`, serviceAccount va boshqa maxfiy fayllarni o'qima va natijada chop etma.
- Production serverga, production Firebase'ga ulanma. GitHub'ga push qilma.
- Mavjud foydalanuvchilar va buyurtmalarni o'chirma.

# NIMANI TEKSHIR
1. server.ts: hashPasswordArgon2idSpec(), barcha xeshlash/tekshirish funksiyalari va ular ishlatiladigan barcha joylar.
2. Endpointlar: /api/security/session, /api/auth/session, /api/auth/hash-password, /api/auth/verify-password, /api/auth/verify-account, /api/auth/complete-migration. Har biri uchun: kim chaqira oladi, qanday tekshiriladi, qanday zaiflik bor.
3. Sessiya va kripto: SESSION_SECRET, AT_REST_MASTER_KEY, issueHttpOnlySessionCookie(), parseCookies(), encryptAtRestAES256GCM(), decryptAtRestAES256GCM(). Standart kalitlar, cookie parametrlari, soxta xavfsizlik headerlari.
4. Firebase telefon tasdiqlash: src/lib/firebase.ts, src/components/AuthModal.tsx, complete-migration. Backend firebasePhoneVerified/firebaseUid ga qanday ishonyapti.
5. firestore.rules: har bir collection uchun kim o'qiy/yoza oladi (users, products, orders, logistika, esco_audits, cabinet_logs).
6. Frontend: adminSettings.ts, securityGuard.ts, AuthModal.tsx, OrdersView.tsx, SupplierCabinet.tsx. localStorage'da parol/xesh saqlanishi.
7. Migratsiya: eski foydalanuvchi ma'lumotlari qayerda va qanday formatda saqlanadi, nimalar yo'qolishi mumkin.

# NATIJA
Loyiha ildizida SECURITY_PLAN.md yarat. Tarkibi:
1. Topilgan muammolar jadvali: raqam | fayl:qator | tavsif | jiddiylik (Critical/High/Medium/Low) | qanday tekshirib isbotlash mumkin.
2. Eski xeshlar bo'yicha xulosa: qaysi formatlar bor va ular qayerda ishlatiladi.
3. Tavsiya etilgan fazalar tartibi (har faza uchun: qaysi fayllar o'zgaradi, xavf nima, qanday test).
4. Menga beriladigan savollar (qaror kerak bo'lgan joylar: masalan, bir telefon bir nechta hisobga biriksa nima qilinadi).
5. Aniq bilmagan yoki taxmin qilgan joylaring (taxminni fakt sifatida yozma).

Oxirida to'xta va mening tasdig'imni kut. Keyingi fazaga o'zing o'tma.
