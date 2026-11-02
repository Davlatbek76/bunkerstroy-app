import { runAuthSecurityMigrationTests } from './authSecurityMigration.test';

runAuthSecurityMigrationTests()
  .then(() => { console.log('AUTH TESTLARI O\'TDI'); process.exit(0); })
  .catch((err) => { console.error('AUTH TESTLARI XATOSI:', err); process.exit(1); });
