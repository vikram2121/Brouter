import mysql from 'mysql2/promise'
import fs from 'fs/promises'
import path from 'path'

export interface DbConnection {
  run(sql: string, params?: any[]): Promise<void>
  get(sql: string, params?: any[]): Promise<any | null>
  all(sql: string, params?: any[]): Promise<any[]>
  close(): Promise<void>
}

class Database implements DbConnection {
  private pool: mysql.Pool | null = null

  async initialize(): Promise<void> {
    const host = process.env.DB_HOST || 'localhost'
    const user = process.env.DB_USER || 'root'
    const password = process.env.DB_PASSWORD || ''
    const database = process.env.DB_NAME || 'brouter'

    this.pool = mysql.createPool({
      host,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      namedPlaceholders: true,
      decimalNumbers: true,
      dateStrings: false
    })

    // Handle pool-level errors (prevents unhandled rejection crashes)
    this.pool.on('connection', (connection) => {
      connection.on('error', (err) => {
        console.error('[DB] Connection error:', err)
      })
    })

    // Initialize schema if needed
    await this.initializeSchema()
    console.log(`✓ Database connected: ${host}/${database}`)
  }

  private async initializeSchema(): Promise<void> {
    try {
      // Check if agents table exists
      const result = await this.all(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'agents'",
        [process.env.DB_NAME || 'brouter']
      )

      if (result.length === 0) {
        console.log('📦 Initializing database schema...')
        const schemaPath = path.join(__dirname, 'schema.sql')
        const schema = await fs.readFile(schemaPath, 'utf-8')

        // Split by semicolon and execute each statement
        // Filter out comment-only lines, keep SQL statements
        const statements = schema
          .split(';')
          .map((s) => {
            // Remove lines that are only comments
            const lines = s.split('\n');
            const sqlLines = lines.filter((line) => {
              const trimmed = line.trim();
              return trimmed.length > 0 && !trimmed.startsWith('--');
            });
            return sqlLines.join('\n').trim();
          })
          .filter((s) => s.length > 0)

        let execCount = 0
        for (const statement of statements) {
          try {
            await this.run(statement)
            execCount++
          } catch (err) {
            console.error(`[DB Schema] Failed to execute statement ${execCount + 1}:`, err)
            throw err
          }
        }
        console.log(`✓ Schema initialized (${execCount} statements executed)`)
      }
    } catch (error) {
      console.error('Schema initialization error:', error)
      throw error
    }
  }

  async run(sql: string, params: any[] = []): Promise<void> {
    if (!this.pool) throw new Error('Database not initialized')

    const connection = await this.pool.getConnection()
    try {
      await connection.execute(sql, params)
    } finally {
      connection.release()
    }
  }

  async get(sql: string, params: any[] = []): Promise<any | null> {
    if (!this.pool) throw new Error('Database not initialized')

    const connection = await this.pool.getConnection()
    try {
      const [rows] = await connection.execute(sql, params)
      const arr = rows as any[]
      return arr.length > 0 ? arr[0] : null
    } finally {
      connection.release()
    }
  }

  async all(sql: string, params: any[] = []): Promise<any[]> {
    if (!this.pool) throw new Error('Database not initialized')

    const connection = await this.pool.getConnection()
    try {
      const [rows] = await connection.execute(sql, params)
      return rows as any[]
    } finally {
      connection.release()
    }
  }

  // Use query() instead of execute() for dynamic IN clauses (array expansion)
  async allRaw(sql: string, params: any[] = []): Promise<any[]> {
    if (!this.pool) throw new Error('Database not initialized')

    const connection = await this.pool.getConnection()
    try {
      const [rows] = await connection.query(sql, params)
      return rows as any[]
    } finally {
      connection.release()
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
      console.log('✓ Database connection closed')
    }
  }
}

// Export class and singleton instance
export { Database }
export const db = new Database()
