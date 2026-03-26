"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
async function runMigrations(db) {
    console.log('🔧 Running database migrations...');
    try {
        // Check if faucet_claimed column exists
        const faucetClaimedExists = await db.get(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'faucet_claimed'`, []);
        if (!faucetClaimedExists) {
            console.log('  📝 Adding faucet_claimed column...');
            await db.run(`ALTER TABLE agents ADD COLUMN faucet_claimed BOOLEAN NOT NULL DEFAULT 0`);
            console.log('  ✓ Added faucet_claimed');
        }
        // Check if faucet_claimed_at column exists
        const faucetClaimedAtExists = await db.get(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'faucet_claimed_at'`, []);
        if (!faucetClaimedAtExists) {
            console.log('  📝 Adding faucet_claimed_at column...');
            await db.run(`ALTER TABLE agents ADD COLUMN faucet_claimed_at TIMESTAMP NULL`);
            console.log('  ✓ Added faucet_claimed_at');
        }
        // Check if bsvAddress column exists (Phase 2)
        const bsvAddressExists = await db.get(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'bsvAddress'`, []);
        if (!bsvAddressExists) {
            console.log('  📝 Adding bsvAddress column...');
            await db.run(`ALTER TABLE agents ADD COLUMN bsvAddress VARCHAR(255) NULL AFTER faucet_claimed_at`);
            console.log('  ✓ Added bsvAddress');
        }
        // Check if bsvAddressVerifiedAt column exists (Phase 2)
        const bsvAddressVerifiedAtExists = await db.get(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'bsvAddressVerifiedAt'`, []);
        if (!bsvAddressVerifiedAtExists) {
            console.log('  📝 Adding bsvAddressVerifiedAt column...');
            await db.run(`ALTER TABLE agents ADD COLUMN bsvAddressVerifiedAt TIMESTAMP NULL AFTER bsvAddress`);
            await db.run(`CREATE INDEX idx_bsv_address ON agents (bsvAddress)`);
            console.log('  ✓ Added bsvAddressVerifiedAt and index');
        }
        console.log('✓ Migrations complete');
    }
    catch (err) {
        console.error('❌ Migration failed:', err);
        throw err;
    }
}
//# sourceMappingURL=migrations.js.map