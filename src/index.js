// WhatsApp Warming Up System - Advanced Multi AI
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
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
const { spawn } = require('child_process');

// Configuration
let CONFIG = {
    telegram: { enabled: false, token: '', chatId: '' },
    proxy: { enabled: false, url: '', startTime: 0, endTime: 0 },
    bio: { enabled: false, autoUpdate: false },
    cooldown: 10800000, // 3 jam
    aiModels: ['glm47flash', 'gpt-o4-mini', 'deepseekr1', 'gptoss120b', 'qwq32b', 'phi2', 'gemini-2.0-flash'],
    currentAIIndex: 0,
    reconnectAttempts: 5
};

// Database setup
let db, kwDb;
const msgCache = new NodeCache({ stdTTL: 3600 });
const activeSessions = new Map();
const monitoringData = new Map();

// Logger
const logger = pino({ 
    level: 'info',
    transport: { target: 'pino-pretty' }
});

// AI API Endpoints
const AI_ENDPOINTS = {
    glm47flash: 'https://api.siputzx.my.id/api/ai/glm47flash',
    'gpt-o4-mini': 'https://api.siputzx.my.id/api/ai/gpt-o4-mini',
    deepseekr1: 'https://api.siputzx.my.id/api/ai/deepseekr1',
    gptoss120b: 'https://api.siputzx.my.id/api/ai/gptoss120b',
    qwq32b: 'https://api.siputzx.my.id/api/ai/qwq32b',
    phi2: 'https://api.siputzx.my.id/api/ai/phi2',
    'gemini-2.0-flash': 'https://api.siputzx.my.id/api/ai/gemini-lite?model=gemini-2.0-flash-lite'
};

// Initialize Databases
async function initDatabases() {
    db = await open({
        filename: './data/numbers.db',
        driver: sqlite3.Database
    });
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS numbers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT UNIQUE NOT NULL,
            name TEXT,
            status TEXT DEFAULT 'pending',
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
            keyword TEXT,
            ai_model TEXT,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (number_id) REFERENCES numbers(id)
        );
        
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    
    kwDb = await open({
        filename: './data/keywords.db',
        driver: sqlite3.Database
    });
    
    await kwDb.exec(`
        CREATE TABLE IF NOT EXISTS keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keyword TEXT UNIQUE NOT NULL,
            type TEXT DEFAULT 'manual',
            usage_count INTEGER DEFAULT 0
        );
        
        CREATE TABLE IF NOT EXISTS ai_keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keyword TEXT,
            prompt TEXT,
            ai_model TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

// AI Service
class AIService {
    constructor() {
        this.currentModel = 0;
    }
    
    async generateKeyword(prompt = "Berikan 1 keyword sapaan formal, santun, dan baik dalam bahasa Indonesia") {
        const model = CONFIG.aiModels[this.currentModel];
        this.currentModel = (this.currentModel + 1) % CONFIG.aiModels.length;
        
        try {
            const endpoint = AI_ENDPOINTS[model] || AI_ENDPOINTS.glm47flash;
            const response = await axios.get(endpoint, {
                params: {
                    prompt: prompt,
                    system: 'Anda adalah asisten yang menghasilkan keyword sapaan singkat, formal dan santun.',
                    temperature: 0.7
                },
                timeout: 15000
            });
            
            let keyword = response.data?.response || response.data?.result || response.data;
            keyword = keyword.replace(/[^\w\s]/gi, '').trim().substring(0, 50);
            
            await kwDb.run(
                'INSERT INTO ai_keywords (keyword, prompt, ai_model) VALUES (?, ?, ?)',
                [keyword, prompt, model]
            );
            
            return keyword;
        } catch (error) {
            logger.error(`AI Generate Error: ${error.message}`);
            return this.getFallbackKeyword();
        }
    }
    
    getFallbackKeyword() {
        const fallbacks = ['Halo', 'Assalamualaikum', 'Selamat pagi', 'Apa kabar?', 'Salam kenal'];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
}

// WhatsApp Bot Class
class WABot {
    constructor(numberId, number, sessionPath) {
        this.numberId = numberId;
        this.number = number;
        this.sessionPath = sessionPath;
        this.sock = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
    }
    
    async connect(usePairing = false) {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        
        const sockOptions = {
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: !usePairing,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        };
        
        if (CONFIG.proxy.enabled && this.isProxyTimeValid()) {
            const HttpsProxyAgent = require('https-proxy-agent');
            sockOptions.agent = new HttpsProxyAgent(CONFIG.proxy.url);
        }
        
        this.sock = makeWASocket(sockOptions);
        
        if (usePairing) {
            const phoneNumber = this.number.replace(/\D/g, '');
            const code = await this.sock.requestPairingCode(phoneNumber);
            logger.info(`Pairing code for ${this.number}: ${code}`);
            this.updateMonitoring('pairing_code', code);
        }
        
        this.sock.ev.on('creds.update', saveCreds);
        
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrcode.generate(qr, { small: true });
                this.updateMonitoring('qr', qr);
            }
            
            if (connection === 'open') {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                logger.info(`✅ Connected: ${this.number}`);
                await this.updateNumberStatus('active');
                
                if (CONFIG.bio.enabled && CONFIG.bio.autoUpdate) {
                    await this.updateBio();
                }
                
                this.startScheduler();
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect && this.reconnectAttempts < CONFIG.reconnectAttempts) {
                    this.reconnectAttempts++;
                    logger.warn(`Reconnecting ${this.number} (${this.reconnectAttempts}/${CONFIG.reconnectAttempts})`);
                    setTimeout(() => this.connect(usePairing), 5000 * this.reconnectAttempts);
                } else {
                    await this.updateNumberStatus('disconnected');
                    logger.error(`❌ Disconnected: ${this.number}`);
                }
            }
        });
        
        return this.sock;
    }
    
    async updateBio() {
        try {
            const bio = await this.getRandomBio();
            await this.sock.updateProfileStatus(bio);
            logger.info(`Bio updated for ${this.number}: ${bio}`);
        } catch (error) {
            logger.error(`Bio update failed: ${error.message}`);
        }
    }
    
    async getRandomBio() {
        const bios = [
            'Selalu ada untukmu 🤗',
            'Senyum itu ibadah 😊',
            'Hidup itu sederhana',
            'Bersyukur selalu 🙏',
            'Stay positive ✨'
        ];
        return bios[Math.floor(Math.random() * bios.length)];
    }
    
    async sendWarmingMessage(targetNumber, keyword) {
        try {
            const formattedNumber = targetNumber.includes('@s.whatsapp.net') 
                ? targetNumber 
                : `${targetNumber}@s.whatsapp.net`;
            
            await this.sock.presenceSubscribe(formattedNumber);
            await this.sock.sendPresenceUpdate('composing', formattedNumber);
            
            await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 2000));
            
            const message = await this.sock.sendMessage(formattedNumber, { 
                text: keyword 
            });
            
            await this.sock.sendPresenceUpdate('paused', formattedNumber);
            
            await db.run(
                'INSERT INTO chat_history (number_id, keyword, ai_model) VALUES (?, ?, ?)',
                [this.numberId, keyword, CONFIG.aiModels[CONFIG.currentAIIndex]]
            );
            
            await db.run(
                'UPDATE numbers SET last_chat = datetime("now"), total_chats = total_chats + 1, cooldown_until = datetime("now", "+3 hours") WHERE id = ?',
                [this.numberId]
            );
            
            logger.info(`✅ Message sent from ${this.number} to ${targetNumber}: ${keyword}`);
            this.updateMonitoring('last_message', { target: targetNumber, keyword, time: new Date() });
            
            return message;
        } catch (error) {
            logger.error(`Send message failed: ${error.message}`);
            throw error;
        }
    }
    
    isProxyTimeValid() {
        if (!CONFIG.proxy.enabled) return false;
        const now = new Date().getHours();
        return now >= CONFIG.proxy.startTime && now < CONFIG.proxy.endTime;
    }
    
    startScheduler() {
        cron.schedule('0 */3 * * *', async () => {
            await this.executeWarming();
        });
    }
    
    async executeWarming() {
        try {
            const targetNumber = await this.getTargetNumber();
            let keyword = await this.getKeyword();
            
            if (!keyword) {
                const ai = new AIService();
                keyword = await ai.generateKeyword();
            }
            
            await this.sendWarmingMessage(targetNumber, keyword);
        } catch (error) {
            logger.error(`Warming execution failed: ${error.message}`);
        }
    }
    
    async getTargetNumber() {
        const result = await db.get(
            'SELECT number FROM numbers WHERE status = "active" AND id != ? ORDER BY RANDOM() LIMIT 1',
            [this.numberId]
        );
        return result?.number || '6281234567890';
    }
    
    async getKeyword() {
        const result = await kwDb.get(
            'SELECT keyword FROM keywords ORDER BY usage_count ASC, RANDOM() LIMIT 1'
        );
        
        if (result) {
            await kwDb.run(
                'UPDATE keywords SET usage_count = usage_count + 1 WHERE keyword = ?',
                [result.keyword]
            );
            return result.keyword;
        }
        return null;
    }
    
    async updateNumberStatus(status) {
        await db.run('UPDATE numbers SET status = ? WHERE id = ?', [status, this.numberId]);
    }
    
    updateMonitoring(key, value) {
        const data = monitoringData.get(this.numberId) || {};
        data[key] = value;
        data.lastUpdate = new Date();
        monitoringData.set(this.numberId, data);
    }
    
    async disconnect() {
        if (this.sock) {
            await this.sock.logout();
            this.isConnected = false;
        }
    }
}

// Telegram Bot Manager
class TelegramManager {
    constructor() {
        this.bot = null;
    }
    
    init(token) {
        if (!token) return;
        
        this.bot = new TelegramBot(token, { polling: true });
        
        this.bot.onText(/\/status/, async (msg) => {
            const status = await this.getStatus();
            this.bot.sendMessage(msg.chat.id, status, { parse_mode: 'HTML' });
        });
        
        this.bot.onText(/\/numbers/, async (msg) => {
            const numbers = await this.getNumbersList();
            this.bot.sendMessage(msg.chat.id, numbers);
        });
        
        this.bot.onText(/\/add (.+)/, async (msg, match) => {
            const number = match[1];
            await this.addNumber(number);
            this.bot.sendMessage(msg.chat.id, `✅ Number ${number} added`);
        });
        
        this.bot.onText(/\/start (.+)/, async (msg, match) => {
            const number = match[1];
            await this.startBot(number);
            this.bot.sendMessage(msg.chat.id, `▶️ Starting bot for ${number}`);
        });
        
        logger.info('🤖 Telegram Bot initialized');
    }
    
    async getStatus() {
        const stats = await db.get('SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as active FROM numbers');
        return `<b>📊 Status WU System</b>\n` +
               `Total Numbers: ${stats.total}\n` +
               `Active: ${stats.active}\n` +
               `Cooldown: 3 Hours\n` +
               `AI Models: ${CONFIG.aiModels.length}`;
    }
    
    async getNumbersList() {
        const numbers = await db.all('SELECT number, status, total_chats, last_chat FROM numbers LIMIT 20');
        return numbers.map(n => 
            `${n.number} | ${n.status} | Chats: ${n.total_chats} | Last: ${n.last_chat || 'Never'}`
        ).join('\n');
    }
    
    async addNumber(number) {
        await db.run('INSERT OR IGNORE INTO numbers (number, status) VALUES (?, "pending")', [number]);
    }
    
    async startBot(number) {
        const numData = await db.get('SELECT * FROM numbers WHERE number = ?', [number]);
        if (numData) {
            const bot = new WABot(numData.id, number, `./sessions/${number.replace(/\D/g, '')}`);
            activeSessions.set(numData.id, bot);
            await bot.connect(CONFIG.pairingMode || false);
        }
    }
}

// Monitoring Dashboard
class MonitorDashboard {
    constructor() {
        this.screen = null;
        this.grid = null;
        this.table = null;
        this.logBox = null;
    }
    
    init() {
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'WhatsApp Warming Up System'
        });
        
        this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });
        
        this.table = this.grid.set(0, 0, 6, 12, contrib.table, {
            keys: true,
            fg: 'white',
            selectedFg: 'white',
            selectedBg: 'blue',
            label: '📱 Active Numbers',
            columnSpacing: 3,
            columnWidth: [15, 10, 10, 15, 20]
        });
        
        this.logBox = this.grid.set(6, 0, 6, 12, contrib.log, {
            fg: 'green',
            selectedFg: 'green',
            label: '📋 System Logs'
        });
        
        this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
        
        this.startUpdateLoop();
        this.screen.render();
    }
    
    startUpdateLoop() {
        setInterval(() => {
            this.updateDisplay();
        }, 2000);
    }
    
    async updateDisplay() {
        const numbers = await db.all(`
            SELECT number, status, total_chats, 
                   CASE WHEN cooldown_until > datetime('now') 
                        THEN 'Cooling' ELSE 'Ready' END as cooldown,
                   ai_model
            FROM numbers 
            WHERE status != 'disconnected'
            LIMIT 20
        `);
        
        const tableData = {
            headers: ['Number', 'Status', 'Chats', 'Cooldown', 'AI Model'],
            data: numbers.map(n => [
                n.number.slice(-10),
                n.status,
                n.total_chats.toString(),
                n.cooldown,
                n.ai_model || 'Auto'
            ])
        };
        
        this.table.setData(tableData);
        this.screen.render();
    }
    
    log(message, type = 'info') {
        const colors = { info: 'green', warn: 'yellow', error: 'red' };
        this.logBox.log(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
}

// Main Application
class WarmingUpSystem {
    constructor() {
        this.ai = new AIService();
        this.monitor = new MonitorDashboard();
        this.telegram = new TelegramManager();
    }
    
    async initialize() {
        await fs.mkdir('./data', { recursive: true });
        await fs.mkdir('./sessions', { recursive: true });
        
        await initDatabases();
        await this.loadConfig();
        
        if (CONFIG.telegram.enabled) {
            this.telegram.init(CONFIG.telegram.token);
        }
        
        this.monitor.init();
        
        logger.info('🚀 WhatsApp Warming Up System Started');
        logger.info(`📊 AI Models: ${CONFIG.aiModels.join(', ')}`);
        
        await this.loadAllNumbers();
    }
    
    async loadConfig() {
        try {
            const configData = await fs.readFile('./config.json', 'utf8');
            CONFIG = { ...CONFIG, ...JSON.parse(configData) };
        } catch (error) {
            await fs.writeFile('./config.json', JSON.stringify(CONFIG, null, 2));
        }
    }
    
    async loadAllNumbers() {
        const numbers = await db.all('SELECT * FROM numbers WHERE status != "disconnected"');
        
        for (const num of numbers) {
            const bot = new WABot(num.id, num.number, `./sessions/${num.number.replace(/\D/g, '')}`);
            activeSessions.set(num.id, bot);
            
            setTimeout(() => {
                bot.connect(CONFIG.pairingMode || false);
            }, 1000 * activeSessions.size);
        }
        
        logger.info(`📱 Loaded ${numbers.length} numbers`);
    }
    
    async addNumber(number, usePairing = false) {
        await db.run('INSERT OR IGNORE INTO numbers (number, status) VALUES (?, "pending")', [number]);
        const numData = await db.get('SELECT * FROM numbers WHERE number = ?', [number]);
        
        const bot = new WABot(numData.id, number, `./sessions/${number.replace(/\D/g, '')}`);
        activeSessions.set(numData.id, bot);
        
        await bot.connect(usePairing);
        
        return bot;
    }
}

// CLI Interface
const program = require('commander');

program
    .version('2.0.0')
    .description('WhatsApp Warming Up System with Multi AI');

program
    .command('start')
    .description('Start the warming up system')
    .action(async () => {
        const system = new WarmingUpSystem();
        await system.initialize();
    });

program
    .command('add <number>')
    .description('Add new WhatsApp number')
    .option('-p, --pairing', 'Use pairing code instead of QR')
    .action(async (number, options) => {
        const system = new WarmingUpSystem();
        await initDatabases();
        await system.addNumber(number, options.pairing);
    });

program
    .command('keywords')
    .description('Manage keywords')
    .option('-a, --add <keyword>', 'Add keyword')
    .option('-l, --list', 'List all keywords')
    .option('-g, --generate', 'Generate keyword with AI')
    .action(async (options) => {
        await initDatabases();
        const ai = new AIService();
        
        if (options.add) {
            await kwDb.run('INSERT OR IGNORE INTO keywords (keyword) VALUES (?)', [options.add]);
            console.log(`✅ Keyword added: ${options.add}`);
        } else if (options.list) {
            const keywords = await kwDb.all('SELECT keyword, usage_count FROM keywords');
            console.table(keywords);
        } else if (options.generate) {
            const keyword = await ai.generateKeyword();
            console.log(`🤖 Generated: ${keyword}`);
        }
    });

program
    .command('config')
    .description('Configure system settings')
    .option('--telegram-token <token>', 'Set Telegram bot token')
    .option('--telegram-chat <chatId>', 'Set Telegram chat ID')
    .option('--proxy <url>', 'Set proxy URL')
    .option('--proxy-time <time>', 'Set proxy active time (HH-HH)')
    .action(async (options) => {
        const config = JSON.parse(await fs.readFile('./config.json', 'utf8'));
        
        if (options.telegramToken) config.telegram.token = options.telegramToken;
        if (options.telegramChat) config.telegram.chatId = options.telegramChat;
        if (options.proxy) config.proxy.url = options.proxy;
        if (options.proxyTime) {
            const [start, end] = options.proxyTime.split('-');
            config.proxy.startTime = parseInt(start);
            config.proxy.endTime = parseInt(end);
        }
        
        await fs.writeFile('./config.json', JSON.stringify(config, null, 2));
        console.log('✅ Configuration updated');
    });

program.parse(process.argv);
