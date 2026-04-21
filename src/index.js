const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const axios = require('axios');
const cron = require('node-cron');
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const qrcode = require('qrcode-terminal');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const EventEmitter = require('events');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
let CONFIG = {
    telegram: { enabled: false, token: '', chatId: '' },
    proxy: { enabled: false, url: '', startTime: 0, endTime: 0 },
    bio: { enabled: true, autoUpdate: true },
    cooldown: 3, // hours
    firstConnectDelay: 2, // hours
    aiModels: ['glm47flash', 'gpt-o4-mini', 'deepseekr1', 'gptoss120b', 'qwq32b', 'phi2', 'gemini-2.0-flash'],
    pairingMode: false,
    reconnectAttempts: 5,
    keywords: { autoGenerate: true, maxAIKeywords: 100 }
};

// ==================== AI ENDPOINTS ====================
const AI_ENDPOINTS = {
    glm47flash: 'https://api.siputzx.my.id/api/ai/glm47flash',
    'gpt-o4-mini': 'https://api.siputzx.my.id/api/ai/gpt-o4-mini',
    deepseekr1: 'https://api.siputzx.my.id/api/ai/deepseekr1',
    gptoss120b: 'https://api.siputzx.my.id/api/ai/gptoss120b',
    qwq32b: 'https://api.siputzx.my.id/api/ai/qwq32b',
    phi2: 'https://api.siputzx.my.id/api/ai/phi2',
    'gemini-2.0-flash': 'https://api.siputzx.my.id/api/ai/gemini-lite'
};

const FALLBACK_KEYWORDS = ['Halo', 'Assalamualaikum', 'Selamat pagi', 'Apa kabar?', 'Salam kenal', 'Hai', 'Permisi'];
const FALLBACK_BIOS = ['Selalu ada untukmu 🤗', 'Senyum itu ibadah 😊', 'Hidup itu sederhana', 'Bersyukur selalu 🙏', 'Stay positive ✨'];

// ==================== GLOBAL STATE ====================
let db, kwDb;
const activeBots = new Map();
const scheduler = new EventEmitter();
const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
let monitorDashboard = null;
let telegramBot = null;
let currentAIModelIndex = 0;
let systemReady = false;

// ==================== HELPER FUNCTIONS ====================
const Helper = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    randomSleep: async (min, max) => Helper.sleep(Math.floor(Math.random() * (max - min + 1)) + min),
    formatPhone: (number) => number.replace(/\D/g, ''),
    randomItem: (arr) => arr[Math.floor(Math.random() * arr.length)],
    formatTime: (timestamp) => timestamp ? new Date(timestamp).toLocaleString('id-ID') : 'Never',
    timeAgo: (date) => {
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);
        if (seconds < 60) return `${seconds} detik lalu`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} menit lalu`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam lalu`;
        return `${Math.floor(seconds / 86400)} hari lalu`;
    }
};

// ==================== DATABASE MANAGER ====================
class DatabaseManager {
    async initialize() {
        await fs.mkdir('./data', { recursive: true });
        await fs.mkdir('./sessions', { recursive: true });
        
        db = await open({ filename: './data/numbers.db', driver: sqlite3.Database });
        await db.exec(`
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
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT,
                message TEXT,
                metadata TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_numbers_status ON numbers(status);
            CREATE INDEX IF NOT EXISTS idx_numbers_cooldown ON numbers(cooldown_until);
        `);
        
        kwDb = await open({ filename: './data/keywords.db', driver: sqlite3.Database });
        await kwDb.exec(`
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
        
        const count = await kwDb.get('SELECT COUNT(*) as cnt FROM keywords');
        if (count.cnt === 0) {
            for (const kw of FALLBACK_KEYWORDS) {
                await kwDb.run('INSERT OR IGNORE INTO keywords (keyword, type) VALUES (?, ?)', [kw, 'default']);
            }
        }
    }

    async getNumber(id) { return await db.get('SELECT * FROM numbers WHERE id = ?', [id]); }
    async getNumberByPhone(phone) { return await db.get('SELECT * FROM numbers WHERE number = ?', [phone]); }
    async getAllActiveNumbers() { return await db.all("SELECT * FROM numbers WHERE status = 'active'"); }
    async getAllNumbers() { return await db.all('SELECT * FROM numbers ORDER BY created_at DESC'); }
    
    async addNumber(number, name = null) {
        const result = await db.run('INSERT OR IGNORE INTO numbers (number, name, status) VALUES (?, ?, ?)', [number, name, 'pending']);
        return result.lastID;
    }
    
    async updateNumberStatus(id, status) { await db.run('UPDATE numbers SET status = ? WHERE id = ?', [status, id]); }
    
    async updateFirstConnect(id) {
        await db.run('UPDATE numbers SET first_connect = datetime("now") WHERE id = ?', [id]);
    }
    
    async updateCooldown(id, hours = 3) {
        await db.run(`UPDATE numbers SET last_chat = datetime('now'), cooldown_until = datetime('now', '+' || ? || ' hours'), total_chats = total_chats + 1 WHERE id = ?`, [hours, id]);
    }
    
    async isFirstConnect(id) {
        const result = await db.get('SELECT first_connect FROM numbers WHERE id = ?', [id]);
        return !result?.first_connect;
    }
    
    async getKeyword() {
        const result = await kwDb.get('SELECT keyword FROM keywords ORDER BY usage_count ASC, RANDOM() LIMIT 1');
        if (result) {
            await kwDb.run('UPDATE keywords SET usage_count = usage_count + 1 WHERE keyword = ?', [result.keyword]);
            return result.keyword;
        }
        return null;
    }
    
    async addKeyword(keyword, type = 'manual') {
        await kwDb.run('INSERT OR IGNORE INTO keywords (keyword, type) VALUES (?, ?)', [keyword, type]);
    }
    
    async getAllKeywords() { return await kwDb.all('SELECT * FROM keywords ORDER BY usage_count DESC'); }
    
    async addAIKeyword(keyword, prompt, model) {
        await kwDb.run('INSERT INTO ai_keywords (keyword, prompt, ai_model) VALUES (?, ?, ?)', [keyword, prompt, model]);
        await this.addKeyword(keyword, 'ai');
    }
    
    async addChatHistory(numberId, targetNumber, keyword, aiModel) {
        await db.run('INSERT INTO chat_history (number_id, target_number, keyword, ai_model) VALUES (?, ?, ?, ?)', [numberId, targetNumber, keyword, aiModel]);
    }
    
    async getChatStats(numberId) {
        return await db.get('SELECT COUNT(*) as total, MAX(sent_at) as last_chat FROM chat_history WHERE number_id = ?', [numberId]);
    }
    
    async getSystemStats() {
        const numbers = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending, SUM(total_chats) as total_chats FROM numbers`);
        const keywords = await kwDb.get('SELECT COUNT(*) as total, SUM(usage_count) as total_used FROM keywords');
        return { numbers, keywords };
    }
    
    async addLog(level, message, metadata = {}) {
        await db.run('INSERT INTO system_logs (level, message, metadata) VALUES (?, ?, ?)', [level, message, JSON.stringify(metadata)]);
    }
    
    async getSetting(key, defaultValue = null) {
        const result = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
        return result ? JSON.parse(result.value) : defaultValue;
    }
    
    async setSetting(key, value) {
        await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
    }
}

// ==================== AI SERVICE ====================
class AIService {
    constructor() {
        this.models = CONFIG.aiModels;
        this.prompts = [
            "Berikan 1 keyword sapaan formal dan santun dalam bahasa Indonesia",
            "Buat 1 kata sapaan singkat yang sopan",
            "Berikan 1 kalimat pembuka yang ramah",
            "Generate 1 greeting message sederhana",
            "Buat 1 sapaan hangat untuk kenalan baru"
        ];
    }
    
    getNextModel() {
        const model = this.models[currentAIModelIndex];
        currentAIModelIndex = (currentAIModelIndex + 1) % this.models.length;
        return model;
    }
    
    async generateKeyword(customPrompt = null) {
        const model = this.getNextModel();
        const prompt = customPrompt || Helper.randomItem(this.prompts);
        const endpoint = AI_ENDPOINTS[model] || AI_ENDPOINTS.glm47flash;
        
        try {
            const params = { prompt, system: 'Anda adalah asisten yang menghasilkan keyword sapaan singkat. Jawab hanya dengan 1-3 kata saja.', temperature: 0.7 };
            if (model === 'gemini-2.0-flash') params.model = 'gemini-2.0-flash-lite';
            
            const response = await axios.get(endpoint, { params, timeout: 15000 });
            let keyword = response.data?.response || response.data?.result || response.data;
            
            if (typeof keyword === 'object') keyword = JSON.stringify(keyword);
            keyword = String(keyword).replace(/[^\w\s]/gi, '').trim().substring(0, 50);
            
            if (keyword) {
                logger.info(`🤖 [${model}] Generated: "${keyword}"`);
                return { keyword, model, prompt, success: true };
            }
        } catch (error) {
            logger.error(`❌ [${model}] Error: ${error.message}`);
        }
        
        return { keyword: Helper.randomItem(FALLBACK_KEYWORDS), model: 'fallback', prompt, success: false };
    }
    
    async generateBio() {
        const model = this.getNextModel();
        try {
            const response = await axios.get(AI_ENDPOINTS[model], {
                params: { prompt: 'Buat bio WhatsApp singkat positif maksimal 50 karakter', system: 'Jawab singkat maksimal 50 karakter.', temperature: 0.8 },
                timeout: 10000
            });
            return String(response.data?.response || response.data?.result || '').substring(0, 50).trim() || Helper.randomItem(FALLBACK_BIOS);
        } catch {
            return Helper.randomItem(FALLBACK_BIOS);
        }
    }
}

// ==================== WHATSAPP BOT ====================
class WABot extends EventEmitter {
    constructor(numberId, phoneNumber, sessionPath) {
        super();
        this.numberId = numberId;
        this.phoneNumber = phoneNumber;
        this.sessionPath = sessionPath;
        this.sock = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.ai = new AIService();
    }
    
    async connect(usePairing = false) {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            const sockOptions = {
                version, logger: pino({ level: 'silent' }), printQRInTerminal: !usePairing,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
                browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false,
                generateHighQualityLinkPreview: true, syncFullHistory: false
            };
            
            if (CONFIG.proxy.enabled && this.isProxyTimeValid()) {
                sockOptions.agent = new HttpsProxyAgent(CONFIG.proxy.url);
            }
            
            this.sock = makeWASocket(sockOptions);
            
            if (usePairing) {
                setTimeout(async () => {
                    try {
                        const code = await this.sock.requestPairingCode(Helper.formatPhone(this.phoneNumber));
                        logger.info(`📱 Pairing code for ${this.phoneNumber}: ${code}`);
                        console.log(`\n📱 PAIRING CODE: ${code}\n`);
                    } catch (e) {}
                }, 3000);
            }
            
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) { qrcode.generate(qr, { small: true }); this.emit('qr', qr); }
                if (connection === 'open') await this.handleConnectionOpen();
                if (connection === 'close') await this.handleConnectionClose(lastDisconnect);
            });
            
            return this.sock;
        } catch (error) {
            logger.error(`Connection error: ${error.message}`);
            throw error;
        }
    }
    
    async handleConnectionOpen() {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        
        const isFirst = await dbManager.isFirstConnect(this.numberId);
        if (isFirst) {
            await dbManager.updateFirstConnect(this.numberId);
            await dbManager.updateNumberStatus(this.numberId, 'active');
            await dbManager.updateCooldown(this.numberId, CONFIG.firstConnectDelay);
            logger.info(`✅ [${this.phoneNumber}] First connect - Waiting ${CONFIG.firstConnectDelay} hours`);
            console.log(`\n⏰ [${this.phoneNumber}] First connect! Waiting ${CONFIG.firstConnectDelay} hours before first chat.\n`);
        } else {
            await dbManager.updateNumberStatus(this.numberId, 'active');
            logger.info(`✅ [${this.phoneNumber}] Reconnected`);
        }
        
        if (CONFIG.bio.enabled) {
            setTimeout(async () => {
                try {
                    const bio = await this.ai.generateBio();
                    await this.sock.updateProfileStatus(bio);
                    logger.info(`📝 [${this.phoneNumber}] Bio updated: ${bio}`);
                } catch (e) {}
            }, 5000);
        }
        
        this.emit('connected', { number: this.phoneNumber, isFirst });
    }
    
    async handleConnectionClose(lastDisconnect) {
        this.isConnected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && this.reconnectAttempts < CONFIG.reconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(5000 * this.reconnectAttempts, 60000);
            logger.warn(`🔄 [${this.phoneNumber}] Reconnecting in ${delay/1000}s (${this.reconnectAttempts}/${CONFIG.reconnectAttempts})`);
            setTimeout(() => this.connect(CONFIG.pairingMode), delay);
        } else {
            await dbManager.updateNumberStatus(this.numberId, 'disconnected');
            logger.error(`❌ [${this.phoneNumber}] Disconnected`);
            this.emit('disconnected', { number: this.phoneNumber });
        }
    }
    
    async canSendChat() {
        if (!this.isConnected) return { allowed: false, reason: 'Not connected' };
        
        const number = await dbManager.getNumber(this.numberId);
        if (number?.cooldown_until) {
            const cooldownUntil = new Date(number.cooldown_until);
            if (cooldownUntil > new Date()) {
                const remaining = Math.ceil((cooldownUntil - new Date()) / 60000);
                return { allowed: false, reason: `Cooldown: ${remaining}m remaining` };
            }
        }
        
        return { allowed: true };
    }
    
    async sendWarmingMessage(targetNumber, keyword) {
        try {
            const canChat = await this.canSendChat();
            if (!canChat.allowed) return { success: false, reason: canChat.reason };
            
            const formattedNumber = targetNumber.includes('@s.whatsapp.net') ? targetNumber : `${Helper.formatPhone(targetNumber)}@s.whatsapp.net`;
            
            await this.sock.presenceSubscribe(formattedNumber);
            await this.sock.sendPresenceUpdate('composing', formattedNumber);
            await Helper.randomSleep(2000, 5000);
            
            const message = await this.sock.sendMessage(formattedNumber, { text: keyword });
            await this.sock.sendPresenceUpdate('paused', formattedNumber);
            
            await dbManager.addChatHistory(this.numberId, targetNumber, keyword, 'auto');
            await dbManager.updateCooldown(this.numberId, CONFIG.cooldown);
            
            logger.info(`✅ [${this.phoneNumber}] Sent to ${targetNumber}: "${keyword}"`);
            return { success: true, message };
        } catch (error) {
            logger.error(`❌ [${this.phoneNumber}] Send failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    isProxyTimeValid() {
        if (!CONFIG.proxy.enabled) return false;
        const now = new Date().getHours();
        const start = CONFIG.proxy.startTime, end = CONFIG.proxy.endTime;
        if (start === end) return true;
        return start < end ? now >= start && now < end : now >= start || now < end;
    }
    
    async disconnect() {
        if (this.sock) {
            try { await this.sock.logout(); } catch (e) {}
            this.isConnected = false;
        }
    }
    
    getStatus() {
        return {
            number: this.phoneNumber,
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts
        };
    }
}

// ==================== SCHEDULER ====================
class WarmingScheduler extends EventEmitter {
    constructor() { super(); this.isRunning = false; }
    
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        cron.schedule('*/5 * * * *', async () => {
            await this.checkAndExecuteWarming();
        });
        
        setTimeout(() => this.checkAndExecuteWarming(), 5000);
        logger.info('⏰ Scheduler started - Checking every 5 minutes');
    }
    
    async checkAndExecuteWarming() {
        let executed = 0, skipped = 0;
        
        for (const [id, bot] of activeBots) {
            try {
                const canChat = await bot.canSendChat();
                if (!canChat.allowed) { skipped++; continue; }
                
                const targetNumber = await this.getTargetNumber(id);
                if (!targetNumber) continue;
                
                let keyword = await dbManager.getKeyword();
                if (!keyword) {
                    const ai = new AIService();
                    const result = await ai.generateKeyword();
                    keyword = result.keyword;
                    await dbManager.addAIKeyword(keyword, result.prompt, result.model);
                }
                
                const result = await bot.sendWarmingMessage(targetNumber, keyword);
                if (result.success) {
                    executed++;
                    this.emit('warming_sent', { number: bot.phoneNumber, target: targetNumber, keyword });
                    if (monitorDashboard) monitorDashboard.log(`✅ ${bot.phoneNumber} → ${targetNumber}: "${keyword}"`, 'success');
                }
                
                await Helper.sleep(2000);
            } catch (error) {
                logger.error(`Scheduler error: ${error.message}`);
            }
        }
        
        if (executed > 0 || skipped > 0) {
            logger.info(`📊 Cycle complete - Executed: ${executed}, Skipped: ${skipped}`);
        }
    }
    
    async getTargetNumber(excludeId) {
        const numbers = await db.all('SELECT number FROM numbers WHERE status = "active" AND id != ? ORDER BY RANDOM() LIMIT 1', [excludeId]);
        return numbers[0]?.number || '6281234567890';
    }
}

// ==================== MONITOR DASHBOARD ====================
class MonitorDashboard {
    constructor() {
        this.screen = null;
        this.grid = null;
        this.table = null;
        this.logBox = null;
        this.statsBox = null;
    }
    
    init() {
        this.screen = blessed.screen({ smartCSR: true, title: 'WhatsApp Warming Up System v2.0', dockBorders: true });
        this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });
        
        this.statsBox = this.grid.set(0, 0, 2, 12, blessed.box, { label: '📊 System Statistics', tags: true, border: { type: 'line' }, style: { border: { fg: 'cyan' } } });
        
        this.table = this.grid.set(2, 0, 5, 12, contrib.table, {
            keys: true, fg: 'white', selectedFg: 'white', selectedBg: 'blue',
            label: '📱 Active Numbers', columnSpacing: 2, columnWidth: [18, 10, 8, 12, 12]
        });
        
        this.logBox = this.grid.set(7, 0, 5, 12, contrib.log, { fg: 'green', label: '📝 System Logs', bufferLength: 50 });
        
        this.screen.key(['escape', 'q', 'C-c'], () => {
            if (this.updateInterval) clearInterval(this.updateInterval);
            this.screen.destroy();
            process.exit(0);
        });
        
        this.updateInterval = setInterval(() => this.updateDisplay(), 3000);
        this.screen.render();
    }
    
    async updateDisplay() {
        try {
            const stats = await dbManager.getSystemStats();
            this.statsBox.setContent(`
{cyan-fg}Total Numbers:{/cyan-fg} {white-fg}${stats.numbers.total}{/white-fg}
{cyan-fg}Active:{/cyan-fg} {green-fg}${stats.numbers.active}{/green-fg} {cyan-fg}Pending:{/cyan-fg} {yellow-fg}${stats.numbers.pending}{/yellow-fg}
{cyan-fg}Total Chats:{/cyan-fg} {white-fg}${stats.numbers.total_chats}{/white-fg}
{cyan-fg}Keywords Available:{/cyan-fg} {white-fg}${stats.keywords.total}{/white-fg} {cyan-fg}Used:{/cyan-fg} {white-fg}${stats.keywords.total_used}{/white-fg}
{cyan-fg}Cooldown:{/cyan-fg} ${CONFIG.cooldown}h {cyan-fg}First Delay:{/cyan-fg} ${CONFIG.firstConnectDelay}h
            `);
            
            const numbers = await db.all(`
                SELECT number, status, total_chats, 
                       CASE WHEN cooldown_until > datetime('now') THEN '⏳ Cooling' ELSE '✅ Ready' END as cooldown,
                       last_chat
                FROM numbers ORDER BY created_at DESC LIMIT 15
            `);
            
            this.table.setData({
                headers: ['Number', 'Status', 'Chats', 'Cooldown', 'Last Chat'],
                data: numbers.map(n => [n.number.slice(-12), n.status, String(n.total_chats), n.cooldown, Helper.timeAgo(n.last_chat)])
            });
            
            this.screen.render();
        } catch (error) {}
    }
    
    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        this.logBox.log(`[${timestamp}] ${message}`);
        this.screen.render();
    }
    
    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        if (this.screen) this.screen.destroy();
    }
}

// ==================== TELEGRAM MANAGER ====================
class TelegramManager {
    init(token) {
        if (!token) return;
        
        telegramBot = new TelegramBot(token, { polling: true });
        
        telegramBot.onText(/\/start/, (msg) => {
            telegramBot.sendMessage(msg.chat.id, 
                '🤖 *WhatsApp Warming Up Bot*\n\n' +
                '/status - Status sistem\n' +
                '/numbers - Daftar nomor\n' +
                '/add <nomor> - Tambah nomor\n' +
                '/stats - Statistik lengkap',
                { parse_mode: 'Markdown' }
            );
        });
        
        telegramBot.onText(/\/status/, async (msg) => {
            const stats = await dbManager.getSystemStats();
            const message = `📊 *Status*\n• Total: ${stats.numbers.total}\n• Active: ${stats.numbers.active}\n• Total Chats: ${stats.numbers.total_chats}\n• Cooldown: ${CONFIG.cooldown}h\n• First Delay: ${CONFIG.firstConnectDelay}h`;
            telegramBot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
        });
        
        telegramBot.onText(/\/numbers/, async (msg) => {
            const numbers = await db.all('SELECT number, status, total_chats, last_chat FROM numbers LIMIT 15');
            let message = '📋 *Numbers*\n\n';
            numbers.forEach(n => { message += `${n.status === 'active' ? '🟢' : '🔴'} ${n.number} | Chats: ${n.total_chats}\n`; });
            telegramBot.sendMessage(msg.chat.id, message);
        });
        
        telegramBot.onText(/\/add (.+)/, async (msg, match) => {
            const number = match[1].trim();
            if (!number.match(/^\d+$/)) {
                telegramBot.sendMessage(msg.chat.id, '❌ Format nomor tidak valid');
                return;
            }
            await dbManager.addNumber(number);
            telegramBot.sendMessage(msg.chat.id, `✅ Nomor ${number} ditambahkan! Gunakan \`node index.js add ${number} --pairing\` di terminal untuk connect.`, { parse_mode: 'Markdown' });
        });
        
        telegramBot.onText(/\/stats/, async (msg) => {
            const bots = Array.from(activeBots.values()).map(b => `${b.isConnected ? '🟢' : '🔴'} ${b.phoneNumber}`).join('\n');
            telegramBot.sendMessage(msg.chat.id, `📊 *Active Connections*\n\n${bots || 'Tidak ada koneksi aktif'}`);
        });
        
        logger.info('🤖 Telegram Bot initialized');
    }
}

// ==================== MAIN SYSTEM ====================
const dbManager = new DatabaseManager();
const warmingScheduler = new WarmingScheduler();

async function loadConfig() {
    try {
        const data = await fs.readFile('./config.json', 'utf8');
        CONFIG = { ...CONFIG, ...JSON.parse(data) };
    } catch (error) {
        await fs.writeFile('./config.json', JSON.stringify(CONFIG, null, 2));
    }
}

async function loadNumbers() {
    const numbers = await dbManager.getAllActiveNumbers();
    logger.info(`📱 Loading ${numbers.length} numbers...`);
    
    for (const num of numbers) {
        await addBot(num);
        await Helper.sleep(2000);
    }
}

async function addBot(numberData) {
    const sessionPath = path.join(process.cwd(), 'sessions', Helper.formatPhone(numberData.number));
    const bot = new WABot(numberData.id, numberData.number, sessionPath);
    
    bot.on('connected', (data) => {
        if (monitorDashboard) monitorDashboard.log(`✅ ${data.number} connected${data.isFirst ? ' (First time - waiting 2h)' : ''}`, 'success');
    });
    
    bot.on('disconnected', (data) => {
        if (monitorDashboard) monitorDashboard.log(`❌ ${data.number} disconnected`, 'error');
    });
    
    activeBots.set(numberData.id, bot);
    
    try {
        await bot.connect(CONFIG.pairingMode);
        if (monitorDashboard) monitorDashboard.log(`Bot ${numberData.number} connecting...`, 'info');
    } catch (error) {
        logger.error(`Failed to connect ${numberData.number}: ${error.message}`);
    }
    
    return bot;
}

async function addNewNumber(phoneNumber, usePairing = false) {
    console.log(`\n📱 Adding new number: ${phoneNumber}`);
    
    const id = await dbManager.addNumber(phoneNumber);
    const numberData = await dbManager.getNumber(id);
    
    const bot = await addBot(numberData);
    
    console.log(`✅ Number added. Waiting for connection...`);
    if (usePairing) console.log(`📱 Pairing mode enabled - check pairing code above`);
    else console.log(`📱 Scan QR code to connect`);
    
    return bot;
}

async function initialize() {
    console.log('\n🚀 Initializing WhatsApp Warming Up System v2.0\n');
    
    await dbManager.initialize();
    console.log('✅ Database initialized');
    
    await loadConfig();
    console.log('✅ Configuration loaded');
    
    if (CONFIG.telegram?.enabled) {
        new TelegramManager().init(CONFIG.telegram.token);
    }
    
    monitorDashboard = new MonitorDashboard();
    
    warmingScheduler.on('warming_sent', (data) => {
        dbManager.addLog('info', 'Warming sent', data);
    });
    
    await loadNumbers();
    
    warmingScheduler.start();
    monitorDashboard.init();
    
    console.log('\n✨ System ready!\n');
    console.log('Commands:');
    console.log('  node index.js start          - Start system');
    console.log('  node index.js add <number>   - Add new number');
    console.log('  node index.js status         - Show status');
    console.log('  node index.js keywords -l    - List keywords');
    console.log('  node index.js keywords -g    - Generate AI keyword\n');
    
    systemReady = true;
}

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    
    for (const [id, bot] of activeBots) {
        await bot.disconnect();
    }
    
    if (monitorDashboard) {
        monitorDashboard.destroy();
    }
    
    process.exit(0);
}

// ==================== CLI INTERFACE ====================
const program = require('commander');

program.version('2.0.0').description('WhatsApp Warming Up System with Multi AI & 2h First Delay');

program.command('start').description('Start the system').action(async () => {
    await initialize();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
});

program.command('add <number>').description('Add new WhatsApp number').option('-p, --pairing', 'Use pairing code').action(async (number, options) => {
    await dbManager.initialize();
    await loadConfig();
    await addNewNumber(number, options.pairing);
    
    // Keep running
    await new Promise(() => {});
});

program.command('status').description('Show system status').action(async () => {
    await dbManager.initialize();
    const stats = await dbManager.getSystemStats();
    const bots = Array.from(activeBots.values()).map(b => b.getStatus());
    console.log(JSON.stringify({ stats, bots, config: CONFIG }, null, 2));
    process.exit(0);
});

program.command('keywords').description('Manage keywords').option('-a, --add <keyword>', 'Add keyword').option('-l, --list', 'List keywords').option('-g, --generate', 'Generate with AI').action(async (options) => {
    await dbManager.initialize();
    
    if (options.add) {
        await dbManager.addKeyword(options.add);
        console.log(`✅ Added: ${options.add}`);
    } else if (options.list) {
        const keywords = await dbManager.getAllKeywords();
        console.table(keywords.slice(0, 20));
    } else if (options.generate) {
        const ai = new AIService();
        const result = await ai.generateKeyword();
        console.log(`🤖 [${result.model}] Generated: "${result.keyword}"`);
    }
    process.exit(0);
});

program.parse(process.argv);
