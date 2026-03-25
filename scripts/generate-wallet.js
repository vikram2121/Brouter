#!/usr/bin/env node

/**
 * Generate Brouter mainnet wallet for BSV payouts
 * Outputs: private key (hex), public key (hex), and BSV address
 */

const crypto = require('crypto');
const { getPublicKey } = require('@noble/secp256k1');

// Minimal BSV address derivation from public key
// P2PKH: hash160(pubKey) -> base58check encode
function hash160(data) {
  const ripemd160 = require('crypto').createHash('ripemd160');
  const sha256 = require('crypto').createHash('sha256');
  return ripemd160.update(sha256.update(data).digest()).digest();
}

function base58Encode(data) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let encoded = '';
  let num = BigInt('0x' + data.toString('hex'));
  
  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = alphabet[remainder] + encoded;
    num = num / 58n;
  }
  
  // Add leading zeros
  for (let i = 0; i < data.length && data[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  
  return encoded;
}

function base58CheckEncode(data) {
  const checksum = crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(data).digest())
    .digest()
    .slice(0, 4);
  return base58Encode(Buffer.concat([data, checksum]));
}

function pubKeyToAddress(pubKeyHex) {
  // P2PKH on mainnet: 0x00 prefix
  const pubKeyBuffer = Buffer.from(pubKeyHex, 'hex');
  const h160 = hash160(pubKeyBuffer);
  const versionedHash = Buffer.concat([Buffer.from([0x00]), h160]);
  return base58CheckEncode(versionedHash);
}

// Generate keys
const privateKeyBytes = crypto.randomBytes(32);
const privateKeyHex = privateKeyBytes.toString('hex');
const pubKeyBytes = getPublicKey(privateKeyBytes);
const pubKeyHex = Buffer.from(pubKeyBytes).toString('hex');
const bsvAddress = pubKeyToAddress(pubKeyHex);

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║         BROUTER MAINNET WALLET GENERATED                   ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');
console.log('Private Key (hex):');
console.log(`  ${privateKeyHex}`);
console.log('');
console.log('Public Key (hex):');
console.log(`  ${pubKeyHex}`);
console.log('');
console.log('BSV Address (P2PKH):');
console.log(`  ${bsvAddress}`);
console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('');
console.log('Add to .env.local:');
console.log('');
console.log(`BROUTER_BSV_PRIVATE_KEY=${privateKeyHex}`);
console.log(`BROUTER_BSV_ADDRESS=${bsvAddress}`);
console.log('');
console.log('⚠️  SAVE THIS WALLET INFO SECURELY');
console.log('   Send BSV to this address to fund the faucet');
console.log('');
