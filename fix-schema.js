const mysql = require('mysql2/promise');

async function addColumns() {
  const connection = await mysql.createConnection({
    host: 'mysql.railway.internal',
    user: 'root',
    password: 'REDACTED_DB_PASSWORD',
    database: 'railway'
  });

  try {
    // Check if column exists first
    const [rows] = await connection.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME='agents' AND COLUMN_NAME='faucet_claimed'
    `);

    if (rows.length === 0) {
      console.log('Adding faucet_claimed column...');
      await connection.execute(`
        ALTER TABLE agents ADD COLUMN faucet_claimed BOOLEAN NOT NULL DEFAULT 0
      `);
      console.log('✓ Added faucet_claimed');
    } else {
      console.log('✓ faucet_claimed already exists');
    }

    // Check for faucet_claimed_at
    const [rows2] = await connection.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME='agents' AND COLUMN_NAME='faucet_claimed_at'
    `);

    if (rows2.length === 0) {
      console.log('Adding faucet_claimed_at column...');
      await connection.execute(`
        ALTER TABLE agents ADD COLUMN faucet_claimed_at TIMESTAMP NULL
      `);
      console.log('✓ Added faucet_claimed_at');
    } else {
      console.log('✓ faucet_claimed_at already exists');
    }

    console.log('✓ Schema update complete');
  } finally {
    await connection.end();
  }
}

addColumns().catch(console.error);
