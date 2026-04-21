// Database Manager - SQLite
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs').promises;

class DatabaseManager {
    constructor() {
        this.db = null;
        this.kwDb = null;
        this.dataDir = path.join(process.cwd(), 'data');
    }
    
    async initialize() {
        await fs.mkdir(this.dataDir, { recursive: true });
        await fs.mkdir(path.join(process.cwd(), 'sessions'), { recursive: true });
        
        this.db = await open({
            filename: path.join(this.dataDir, 'numbers.db'),
            driver: sqlite3.Database
        });
        
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS numbers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT UNIQUE NOT NULL,
                name TEXT,
                status TEXT DEFAULT 'pending',
                first_connect TIMESTAMP,
                last_chat TIMESTAMP,
                cooldown_until TIMESTAMP,
                session_path TEXT,
                bio TEXT,
                proxy TEXT,
                ai_model TEXT,
                total_chats INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number_id INTEGER,
                target_number TEXT,
                keyword TEXT,
                ai_model TEXT,
                status TEXT DEFAULT 'sent',
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (number_id) REFERENCES numbers(id)
            );
            
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT,
                message TEXT,
                metadata TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Indexes for performance
        await this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_numbers_status ON numbers(status);
            CREATE INDEX IF NOT EXISTS idx_numbers_cooldown ON numbers(cooldown_until);
            CREATE INDEX IF NOT EXISTS idx_chat_history_number ON chat_history(number_id);
        `);
        
        this.kwDb = await open({
            filename: path.join(this.dataDir, 'keywords.db'),
            driver: sqlite3.Database
        });
        
        await this.kwDb.exec(`
            CREATE TABLE IF NOT EXISTS keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT UNIQUE NOT NULL,
                type TEXT DEFAULT 'manual',
                usage_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS ai_keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT,
                prompt TEXT,
                ai_model TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Insert default keywords if empty
        const count = await this.kwDb.get('SELECT COUNT(*) as cnt FROM keywords');
        if (count.cnt === 0) {
            const defaultKeywords = [
                'Halo', 'Assalamualaikum', 'Selamat pagi', 
                'Apa kabar?', 'Salam kenal', 'Hai'
            ];
            for (const kw of defaultKeywords) {
                await this.kwDb.run(
                    'INSERT OR IGNORE INTO keywords (keyword, type) VALUES (?, ?)',
                    [kw, 'default']
                );
            }
        }
    }
    
    // Number operations
    async getNumber(id) {
        return await this.db.get('SELECT * FROM numbers WHERE id = ?', [id]);
    }
    
    async getNumberByPhone(phone) {
        return await this.db.get('SELECT * FROM numbers WHERE number = ?', [phone]);
    }
    
    async getAllActiveNumbers() {
        return await this.db.all(`
            SELECT * FROM numbers 
            WHERE status = 'active' 
            AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
        `);
    }
    
    async getAllNumbers() {
        return await this.db.all('SELECT * FROM numbers ORDER BY created_at DESC');
    }
    
    async addNumber(number, name = null) {
        const result = await this.db.run(
            'INSERT OR IGNORE INTO numbers (number, name, status) VALUES (?, ?, ?)',
            [number, name, 'pending']
        );
        return result.lastID;
    }
    
    async updateNumberStatus(id, status) {
        await this.db.run('UPDATE numbers SET status = ? WHERE id = ?', [status, id]);
    }
    
    async updateFirstConnect(id) {
        await this.db.run(
            'UPDATE numbers SET first_connect = datetime("now") WHERE id = ?',
            [id]
        );
    }
    
    async updateCooldown(id, hours = 3) {
        await this.db.run(
            `UPDATE numbers SET 
                last_chat = datetime('now'),
                cooldown_until = datetime('now', '+' || ? || ' hours'),
                total_chats = total_chats + 1 
            WHERE id = ?`,
            [hours, id]
        );
    }
    
    async isFirstConnect(id) {
        const result = await this.db.get(
            'SELECT first_connect FROM numbers WHERE id = ?',
            [id]
        );
        return !result?.first_connect;
    }
    
    async getTimeSinceFirstConnect(id) {
        const result = await this.db.get(
            `SELECT 
                first_connect,
                CAST((julianday('now') - julianday(first_connect)) * 24 * 60 AS INTEGER) as minutes_since
            FROM numbers WHERE id = ?`,
            [id]
        );
        return result?.minutes_since || 0;
    }
    
    // Keyword operations
    async getKeyword() {
        const result = await this.kwDb.get(`
            SELECT keyword FROM keywords 
            ORDER BY usage_count ASC, RANDOM() 
            LIMIT 1
        `);
        
        if (result) {
            await this.kwDb.run(
                'UPDATE keywords SET usage_count = usage_count + 1 WHERE keyword = ?',
                [result.keyword]
            );
        }
        
        return result?.keyword || null;
    }
    
    async addKeyword(keyword, type = 'manual') {
        await this.kwDb.run(
            'INSERT OR IGNORE INTO keywords (keyword, type) VALUES (?, ?)',
            [keyword, type]
        );
    }
    
    async getAllKeywords() {
        return await this.kwDb.all('SELECT * FROM keywords ORDER BY usage_count DESC');
    }
    
    async addAIKeyword(keyword, prompt, model) {
        await this.kwDb.run(
            'INSERT INTO ai_keywords (keyword, prompt, ai_model) VALUES (?, ?, ?)',
            [keyword, prompt, model]
        );
        await this.addKeyword(keyword, 'ai');
    }
    
    // Chat history
    async addChatHistory(numberId, targetNumber, keyword, aiModel) {
        await this.db.run(
            'INSERT INTO chat_history (number_id, target_number, keyword, ai_model) VALUES (?, ?, ?, ?)',
            [numberId, targetNumber, keyword, aiModel]
        );
    }
    
    async getChatStats(numberId) {
        return await this.db.get(`
            SELECT 
                COUNT(*) as total,
                MAX(sent_at) as last_chat,
                COUNT(DISTINCT target_number) as unique_targets
            FROM chat_history 
            WHERE number_id = ?
        `, [numberId]);
    }
    
    // Settings
    async getSetting(key, defaultValue = null) {
        const result = await this.db.get('SELECT value FROM settings WHERE key = ?', [key]);
        return result ? JSON.parse(result.value) : defaultValue;
    }
    
    async setSetting(key, value) {
        await this.db.run(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
            [key, JSON.stringify(value)]
        );
    }
    
    // Logs
    async addLog(level, message, metadata = {}) {
        await this.db.run(
            'INSERT INTO system_logs (level, message, metadata) VALUES (?, ?, ?)',
            [level, message, JSON.stringify(metadata)]
        );
    }
    
    async getRecentLogs(limit = 100) {
        return await this.db.all(
            'SELECT * FROM system_logs ORDER BY created_at DESC LIMIT ?',
            [limit]
        );
    }
    
    // Stats
    async getSystemStats() {
        const numbers = await this.db.get(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END) as disconnected,
                SUM(total_chats) as total_chats
            FROM numbers
        `);
        
        const keywords = await this.kwDb.get(`
            SELECT 
                COUNT(*) as total,
                SUM(usage_count) as total_used
            FROM keywords
        `);
        
        return { numbers, keywords };
    }
}

module.exports = DatabaseManager;
