/**
 * Telegram notification helper for ops alerts.
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.
 * Silently no-ops if not configured.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

export async function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  const emoji = level === 'error' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️'
  const text = `${emoji} *Brouter*\n${message}`

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    })
  } catch (e: any) {
    // Never let alert failures crash the server
    console.warn('[notify] Telegram alert failed:', e.message)
  }
}
