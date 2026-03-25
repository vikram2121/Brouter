/**
 * Brouter Wallet — secp256k1 keypair management
 * Uses @noble/secp256k1 v3 + @noble/hashes for real BSV-compatible keys.
 * Private key is never sent to the server.
 */

import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'

const STORAGE_KEY = 'brouter_wallet'

export interface WalletData {
  publicKey: string       // hex compressed secp256k1 pubkey (66 chars)
  bsvAddress: string      // P2PKH address starting with '1'
  encryptedKey: string    // AES-GCM encrypted private key (base64)
  iv: string              // AES-GCM IV (base64)
  salt: string            // PBKDF2 salt (base64)
}

// ── Helpers ─────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map(h => parseInt(h, 16)))
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// ── BSV P2PKH address derivation ─────────────────────────────────

function hash160(pubkeyBytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(pubkeyBytes))
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4)
  const full = new Uint8Array(payload.length + 4)
  full.set(payload)
  full.set(checksum, payload.length)

  let leadingZeros = 0
  for (const b of full) {
    if (b !== 0) break
    leadingZeros++
  }

  let num = BigInt('0x' + bytesToHex(full))
  let result = ''
  const base = BigInt(58)
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % base)] + result
    num = num / base
  }
  return '1'.repeat(leadingZeros) + result
}

function pubkeyToAddress(pubkeyHex: string): string {
  const pubBytes = hexToBytes(pubkeyHex)
  const h160 = hash160(pubBytes)
  const payload = new Uint8Array(21)
  payload[0] = 0x00  // mainnet P2PKH version byte
  payload.set(h160, 1)
  return base58check(payload)
}

// ── Keypair generation ───────────────────────────────────────────

export function generateKeypair(): { privateKeyHex: string; publicKeyHex: string; address: string } {
  const privateKeyBytes = secp.utils.randomSecretKey()
  const publicKeyBytes = secp.getPublicKey(privateKeyBytes, true) // compressed
  const privateKeyHex = bytesToHex(privateKeyBytes)
  const publicKeyHex = bytesToHex(publicKeyBytes)
  const address = pubkeyToAddress(publicKeyHex)
  return { privateKeyHex, publicKeyHex, address }
}

// ── Password-based encryption (Web Crypto AES-GCM) ──────────────

async function deriveKey(password: string, saltBuf: ArrayBuffer): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: 200_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptPrivateKey(privateKeyHex: string, password: string): Promise<{ encryptedKey: string; iv: string; salt: string }> {
  const saltArr = crypto.getRandomValues(new Uint8Array(16))
  const ivArr = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, toArrayBuffer(saltArr))
  const enc = new TextEncoder()
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(ivArr) }, key, enc.encode(privateKeyHex))
  return {
    encryptedKey: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(ivArr),
    salt: bytesToBase64(saltArr),
  }
}

export async function decryptPrivateKey(encryptedKey: string, iv: string, salt: string, password: string): Promise<string> {
  const key = await deriveKey(password, toArrayBuffer(base64ToBytes(salt)))
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(iv)) },
    key,
    toArrayBuffer(base64ToBytes(encryptedKey))
  )
  return new TextDecoder().decode(decrypted)
}

// ── BRC-22 challenge signing ─────────────────────────────────────

export async function signChallenge(challenge: string, privateKeyHex: string): Promise<string> {
  const msgHash = sha256(new TextEncoder().encode(challenge))
  const privBytes = hexToBytes(privateKeyHex)
  const sigBytes = await secp.signAsync(msgHash, privBytes)  // returns DER Uint8Array in v3
  return bytesToHex(sigBytes)
}

// ── localStorage helpers ─────────────────────────────────────────

export function saveWallet(data: WalletData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function loadWallet(): WalletData | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

export function clearWallet(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function hasWallet(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null
}
