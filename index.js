const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers, proto, jidDecode } = require('@whiskeysockets/baileys');
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

// ==================== CONFIG ====================
let CONFIG = {
    telegram: { enabled: false, token: '', chatId: '' },
    proxy: { enabled: false, url: '', startTime: 0, endTime: 0 },
    bio: { enabled: true, autoUpdate: true },
    cooldown: 3,
    firstConnectDelay: 2,
    aiModels: ['glm47flash', 'gpt-o4-mini', 'deepseekr1', 'gptoss120b', 'qwq32b', 'phi2', 'gemini-2.0-flash'],
    pairingMode: false,
    reconnectAttempts: 5
};

const AI_ENDPOINTS = {
    glm47flash: 'https://api.siputzx.my.id/api/ai/glm47flash',
    'gpt-o4-mini': 'https://api.siputzx.my.id/api/ai/gpt-o4-mini',
    deepseekr1: 'https://api.siputzx.my.id/api/ai/deepseekr1',
    gptoss120b: 'https://api.siputzx.my.id/api/ai/gptoss120b',
    qwq32b: 'https://api.siputzx.my.id/api/ai/qwq32b',
    phi2: 'https://api.siputzx.my.id/api/ai/phi2',
    'gemini-2.0-flash': 'https://api.siputzx.my.id/api/ai/gemini-lite'
};

const FALLBACK_KEYWORDS = ['Halo', 'Assalamualaikum', 'Selamat pagi', 'Apa kabar?', 'Salam kenal', 'Hai'];
const FALLBACK_BIOS = ['✨ Selalu ada untukmu', '😊 Senyum itu ibadah', '🌟 Hidup itu sederhana', '🙏 Bersyukur selalu'];

let db, kwDb;
const activeBots = new Map();
const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
let monitorDashboard = null;
let telegramBot = null;
let currentAIModelIndex = 0;

// ==================== HELPER ====================
const Helper = {
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    randomItem: (arr) => arr[Math.floor(Math.random() * arr.length)],
    formatPhone: (n) => String(n).replace(/\D/g, ''),
    timeAgo: (d) => {
        if (!d) return 'Never';
        const s = Math.floor((new Date() - new Date(d)) / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s/60)}m ago`;
        if (s < 86400) return `${Math.floor(s/3600)}h ago`;
        return `${Math.floor(s/86400)}d ago`;
    }
};

// ==================== DATABASE ====================
class DatabaseManager {
    async initialize() {
        await fs.mkdir('./data', { recursive: true });
        await fs.mkdir('./sessions', { recursive: true });
        
        db = await open({ filename: './data/numbers.db', driver: sqlite3.Database });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS numbers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT UNIQUE NOT NULL,
                jid TEXT,
                status TEXT DEFAULT 'pending',
                first_connect TIMESTAMP,
                last_chat TIMESTAMP,
                cooldown_until TIMESTAMP,
                total_chats INTEGER DEFAULT 0,
                bio TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT UNIQUE NOT NULL,
                name TEXT,
                status TEXT DEFAULT 'active',
                usage_count INTEGER DEFAULT 0,
                last_used TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number_id INTEGER,
                target_number TEXT,
                keyword TEXT,
                ai_model TEXT,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        kwDb = await open({ filename: './data/keywords.db', driver: sqlite3.Database });
        await kwDb.exec(`
            CREATE TABLE IF NOT EXISTS keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT UNIQUE NOT NULL,
                usage_count INTEGER DEFAULT 0
            );
        `);
        
        const c = await kwDb.get('SELECT COUNT(*) as cnt FROM keywords');
        if (c.cnt === 0) {
            for (const k of FALLBACK_KEYWORDS) {
                await kwDb.run('INSERT INTO keywords (keyword) VALUES (?)', [k]);
            }
        }
        console.log('✅ Database ready');
    }
    
    async addNumber(n) { return (await db.run('INSERT OR IGNORE INTO numbers (number) VALUES (?)', [n])).lastID; }
    async getNumber(id) { return await db.get('SELECT * FROM numbers WHERE id = ?', [id]); }
    async getAllActiveNumbers() { return await db.all("SELECT * FROM numbers WHERE status = 'active'"); }
    async updateNumberStatus(id, s) { await db.run('UPDATE numbers SET status = ? WHERE id = ?', [s, id]); }
    async updateJID(id, jid) { await db.run('UPDATE numbers SET jid = ? WHERE id = ?', [jid, id]); }
    async updateFirstConnect(id) { await db.run('UPDATE numbers SET first_connect = datetime("now") WHERE id = ?', [id]); }
    async updateCooldown(id, h) { await db.run(`UPDATE numbers SET last_chat = datetime('now'), cooldown_until = datetime('now', '+' || ? || ' hours'), total_chats = total_chats + 1 WHERE id = ?`, [h, id]); }
    async updateBio(id, bio) { await db.run('UPDATE numbers SET bio = ? WHERE id = ?', [bio, id]); }
    async isFirstConnect(id) { const r = await db.get('SELECT first_connect FROM numbers WHERE id = ?', [id]); return !r?.first_connect; }
    
    async getKeyword() {
        const r = await kwDb.get('SELECT keyword FROM keywords ORDER BY usage_count ASC, RANDOM() LIMIT 1');
        if (r) { await kwDb.run('UPDATE keywords SET usage_count = usage_count + 1 WHERE keyword = ?', [r.keyword]); }
        return r?.keyword;
    }
    
    async addKeyword(k) { await kwDb.run('INSERT OR IGNORE INTO keywords (keyword) VALUES (?)', [k]); }
    async getAllKeywords() { return await kwDb.all('SELECT * FROM keywords ORDER BY usage_count DESC'); }
    
    async addTarget(n) { await db.run('INSERT OR IGNORE INTO targets (number) VALUES (?)', [n]); }
    async getRandomTarget(excludeNumber = null) {
        let q = 'SELECT number FROM targets WHERE status = "active"';
        const p = [];
        if (excludeNumber) { q += ' AND number != ?'; p.push(excludeNumber); }
        q += ' ORDER BY usage_count ASC, RANDOM() LIMIT 1';
        const r = await db.get(q, p);
        if (r) { await db.run('UPDATE targets SET usage_count = usage_count + 1, last_used = datetime("now") WHERE number = ?', [r.number]); }
        return r?.number;
    }
    async getAllTargets() { return await db.all('SELECT * FROM targets ORDER BY usage_count DESC'); }
    async importTargets(file) {
        const c = await fs.readFile(file, 'utf8');
        const nums = c.split('\n').map(l => l.trim()).filter(l => l && l.match(/^\d+$/));
        for (const n of nums) { await this.addTarget(n); }
        return nums.length;
    }
    
    async addChatHistory(nid, target, kw, model) {
        await db.run('INSERT INTO chat_history (number_id, target_number, keyword, ai_model) VALUES (?, ?, ?, ?)', [nid, target, kw, model]);
    }
    
    async getStats() {
        const n = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active, SUM(total_chats) as chats FROM numbers`);
        const k = await kwDb.get('SELECT COUNT(*) as total, SUM(usage_count) as used FROM keywords');
        const t = await db.get('SELECT COUNT(*) as total FROM targets');
        return { numbers: n, keywords: k, targets: t };
    }
}

const dbManager = new DatabaseManager();

// ==================== AI SERVICE ====================
class AIService {
    getNextModel() { 
        const m = CONFIG.aiModels[currentAIModelIndex]; 
        currentAIModelIndex = (currentAIModelIndex + 1) % CONFIG.aiModels.length; 
        return m; 
    }
    
    async generateKeyword() {
        const model = this.getNextModel();
        const endpoint = AI_ENDPOINTS[model] || AI_ENDPOINTS.glm47flash;
        try {
            const r = await axios.get(endpoint, {
                params: { prompt: '1 kata sapaan singkat sopan', system: '1-3 kata', temperature: 0.7 },
                timeout: 10000
            });
            let kw = r.data?.response || r.data?.result || '';
            kw = String(kw).replace(/[^\w\s]/g, '').trim().substring(0, 30);
            return kw || Helper.randomItem(FALLBACK_KEYWORDS);
        } catch { return Helper.randomItem(FALLBACK_KEYWORDS); }
    }
    
    async generateBio() {
        try {
            const r = await axios.get(AI_ENDPOINTS.glm47flash, {
                params: { prompt: 'Bio WA singkat positif 25 karakter', system: 'Jawab singkat', temperature: 0.8 },
                timeout: 8000
            });
            let bio = r.data?.response || r.data?.result || '';
            bio = String(bio).replace(/[^a-zA-Z0-9\s.,!?😊✨🌟💪🙏]/g, '').trim().substring(0, 30);
            return bio || Helper.randomItem(FALLBACK_BIOS);
        } catch { return Helper.randomItem(FALLBACK_BIOS); }
    }
}

// ==================== WHATSAPP BOT ====================
class WABot extends EventEmitter {
    constructor(id, number, sessionPath) {
        super();
        this.id = id;
        this.number = number;
        this.sessionPath = sessionPath;
        this.sock = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.ai = new AIService();
        this.myJID = null;
    }
    
    async connect(usePairing = false) {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            const opts = {
                version, logger: pino({ level: 'silent' }), printQRInTerminal: !usePairing,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
                browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false,
                shouldIgnoreJid: (jid) => false
            };
            
            if (CONFIG.proxy.enabled) opts.agent = new HttpsProxyAgent(CONFIG.proxy.url);
            
            this.sock = makeWASocket(opts);
            
            if (usePairing) {
                setTimeout(async () => {
                    if (!this.sock.authState.creds.registered) {
                        try {
                            const code = await this.sock.requestPairingCode(Helper.formatPhone(this.number));
                            console.log('\n' + '='.repeat(40));
                            console.log(`📱 PAIRING CODE: ${code}`);
                            console.log('='.repeat(40) + '\n');
                        } catch (e) {}
                    }
                }, 5000);
            }
            
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('connection.update', async (u) => {
                const { connection, lastDisconnect, qr } = u;
                if (qr && !usePairing) qrcode.generate(qr, { small: true });
                if (connection === 'open') await this.onOpen();
                if (connection === 'close') await this.onClose(lastDisconnect);
            });
            
            // Handle incoming messages - JANGAN BALAS "Success"
            this.sock.ev.on('messages.upsert', async (m) => {
                if (m.type === 'notify') {
                    for (const msg of m.messages) {
                        // Abaikan pesan masuk, jangan kirim balasan
                        if (!msg.key.fromMe) {
                            console.log(`📨 [${this.number}] Received message from ${msg.key.remoteJid}, ignored`);
                        }
                    }
                }
            });
            
            return this.sock;
        } catch (e) { throw e; }
    }
    
    async onOpen() {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.myJID = this.sock.user.id;
        
        // Simpan JID ke database
        await dbManager.updateJID(this.id, this.myJID);
        
        const isFirst = await dbManager.isFirstConnect(this.id);
        if (isFirst) {
            await dbManager.updateFirstConnect(this.id);
            await dbManager.updateNumberStatus(this.id, 'active');
            await dbManager.updateCooldown(this.id, CONFIG.firstConnectDelay);
            console.log(`\n✅ [${this.number}] First connect! Waiting ${CONFIG.firstConnectDelay}h\n`);
        } else {
            await dbManager.updateNumberStatus(this.id, 'active');
            console.log(`✅ [${this.number}] Connected! (JID: ${this.myJID})`);
        }
        
        // FIX: Update Bio dengan method yang benar
        if (CONFIG.bio.enabled && CONFIG.bio.autoUpdate) {
            setTimeout(async () => {
                await this.updateBio();
            }, 5000);
        }
        
        this.emit('connected', { number: this.number });
    }
    
    async onClose(lastDisconnect) {
        this.connected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && this.reconnectAttempts < CONFIG.reconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => this.connect(CONFIG.pairingMode), 5000 * this.reconnectAttempts);
        } else {
            await dbManager.updateNumberStatus(this.id, 'disconnected');
            console.log(`❌ [${this.number}] Disconnected`);
        }
    }
    
    // FIX: Method updateBio yang BENAR
    async updateBio() {
        try {
            const bio = await this.ai.generateBio();
            
            // Cara benar update status/about di Baileys
            await this.sock.updateProfileStatus(bio);
            
            await dbManager.updateBio(this.id, bio);
            console.log(`📝 [${this.number}] Bio updated: "${bio}"`);
            
        } catch (error) {
            console.log(`⚠️ [${this.number}] Bio failed: ${error.message}`);
            // Fallback manual
            const manualBio = Helper.randomItem(FALLBACK_BIOS);
            try {
                await this.sock.updateProfileStatus(manualBio);
                await dbManager.updateBio(this.id, manualBio);
                console.log(`📝 [${this.number}] Bio (fallback): "${manualBio}"`);
            } catch {
                // Abaikan
            }
        }
    }
    
    async canSend() {
        if (!this.connected) return { ok: false, reason: 'Not connected' };
        const n = await dbManager.getNumber(this.id);
        if (n?.cooldown_until && new Date(n.cooldown_until) > new Date()) {
            const rem = Math.ceil((new Date(n.cooldown_until) - new Date()) / 60000);
            return { ok: false, reason: `Cooldown ${rem}m` };
        }
        return { ok: true };
    }
    
    async sendMessage(target, keyword) {
        const can = await this.canSend();
        if (!can.ok) return { success: false, reason: can.reason };
        
        // CEGAH KIRIM KE DIRI SENDIRI
        const targetClean = Helper.formatPhone(target);
        const myClean = Helper.formatPhone(this.number);
        if (targetClean === myClean) {
            console.log(`⚠️ [${this.number}] Skipped self-chat`);
            return { success: false, reason: 'Cannot chat self' };
        }
        
        try {
            const jid = target.includes('@s.whatsapp.net') ? target : `${targetClean}@s.whatsapp.net`;
            
            // Cek lagi jangan sampai JID sama dengan myJID
            if (jid === this.myJID) {
                console.log(`⚠️ [${this.number}] Skipped self-chat (JID match)`);
                return { success: false, reason: 'Cannot chat self' };
            }
            
            await this.sock.presenceSubscribe(jid);
            await this.sock.sendPresenceUpdate('composing', jid);
            await Helper.sleep(2000 + Math.random() * 3000);
            
            await this.sock.sendMessage(jid, { text: keyword });
            await this.sock.sendPresenceUpdate('paused', jid);
            
            await dbManager.addChatHistory(this.id, target, keyword, 'auto');
            await dbManager.updateCooldown(this.id, CONFIG.cooldown);
            
            console.log(`✅ [${this.number}] → ${target}: "${keyword}"`);
            return { success: true };
        } catch (e) {
            console.error(`❌ [${this.number}] Send failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    }
    
    async disconnect() { 
        if (this.sock) { try { await this.sock.logout(); } catch(e) {} }
    }
}

// ==================== SCHEDULER ====================
class Scheduler extends EventEmitter {
    start() {
        cron.schedule('*/5 * * * *', async () => await this.run());
        setTimeout(() => this.run(), 5000);
        console.log('⏰ Scheduler started');
    }
    
    async run() {
        let sent = 0;
        for (const [id, bot] of activeBots) {
            if (!bot.connected) continue;
            
            const can = await bot.canSend();
            if (!can.ok) continue;
            
            // Cari target - PASTIKAN BUKAN DIRI SENDIRI
            let target = await dbManager.getRandomTarget(bot.number);
            
            if (!target) {
                // Cari dari database numbers selain diri sendiri
                const nums = await db.all(
                    'SELECT number FROM numbers WHERE status = "active" AND number != ? ORDER BY RANDOM() LIMIT 1', 
                    [bot.number]
                );
                target = nums[0]?.number;
            }
            
            // Fallback target
            if (!target) {
                target = '6281234567890';
            }
            
            // Double-check jangan sampai target sama dengan nomor bot
            if (Helper.formatPhone(target) === Helper.formatPhone(bot.number)) {
                console.log(`⚠️ [${bot.number}] Target is self, skipping`);
                continue;
            }
            
            let kw = await dbManager.getKeyword();
            if (!kw) kw = await new AIService().generateKeyword();
            
            const r = await bot.sendMessage(target, kw);
            if (r.success) sent++;
            
            await Helper.sleep(3000);
        }
        if (sent > 0) console.log(`📊 Sent ${sent} messages`);
    }
}

const scheduler = new Scheduler();

// ==================== MONITOR (SIMPLE) ====================
class Monitor {
    constructor() {
        this.ready = false;
        this.screen = null;
        this.logBox = null;
    }
    
    init() {
        try {
            this.screen = blessed.screen({ smartCSR: true, title: 'WU System' });
            const grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });
            
            this.logBox = grid.set(0, 0, 12, 12, contrib.log, { 
                fg: 'green', label: '📝 Logs', bufferLength: 100 
            });
            
            this.screen.key(['q', 'C-c'], () => { 
                this.destroy(); 
                process.exit(0); 
            });
            
            this.ready = true;
            this.screen.render();
            console.log('🖥️ Monitor ready');
        } catch (e) {
            console.log('⚠️ Console mode');
        }
    }
    
    log(msg) {
        console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (this.ready && this.logBox) {
            this.logBox.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
            if (this.screen) this.screen.render();
        }
    }
    
    destroy() { 
        if (this.screen) this.screen.destroy(); 
    }
}

// ==================== MAIN ====================
async function loadConfig() {
    try { 
        CONFIG = { ...CONFIG, ...JSON.parse(await fs.readFile('./config.json', 'utf8')) }; 
    } catch { 
        await fs.writeFile('./config.json', JSON.stringify(CONFIG, null, 2)); 
    }
}

async function addBot(numData) {
    const sessionPath = path.join('./sessions', Helper.formatPhone(numData.number));
    const bot = new WABot(numData.id, numData.number, sessionPath);
    
    bot.on('connected', () => {
        if (monitorDashboard) monitorDashboard.log(`✅ ${numData.number} connected`);
    });
    
    activeBots.set(numData.id, bot);
    
    try {
        await bot.connect(CONFIG.pairingMode);
    } catch (e) {
        console.error(`Failed: ${e.message}`);
    }
    return bot;
}

async function loadNumbers() {
    const nums = await dbManager.getAllActiveNumbers();
    console.log(`📱 Loading ${nums.length} numbers...`);
    for (const n of nums) {
        await addBot(n);
        await Helper.sleep(2000);
    }
}

async function initialize() {
    console.log('\n🚀 WhatsApp Warming Up System v2.2\n');
    
    await dbManager.initialize();
    await loadConfig();
    
    monitorDashboard = new Monitor();
    monitorDashboard.init();
    
    if (CONFIG.telegram?.enabled) {
        const tg = new TelegramManager();
        tg.init(CONFIG.telegram.token);
    }
    
    await loadNumbers();
    scheduler.start();
    
    console.log('\n✨ Ready! Commands: node index.js add <number> --pairing\n');
}

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    for (const [id, bot] of activeBots) {
        await bot.disconnect();
    }
    if (monitorDashboard) monitorDashboard.destroy();
    process.exit(0);
}

// ==================== TELEGRAM ====================
class TelegramManager {
    init(token) {
        if (!token) return;
        telegramBot = new TelegramBot(token, { polling: true });
        telegramBot.onText(/\/status/, async (msg) => {
            const s = await dbManager.getStats();
            telegramBot.sendMessage(msg.chat.id, `📊 Numbers: ${s.numbers.total} | Active: ${s.numbers.active} | Chats: ${s.numbers.chats}`);
        });
        console.log('🤖 Telegram ready');
    }
}

// ==================== CLI ====================
const program = require('commander');

program.version('2.2.0');

program.command('start').action(async () => {
    await initialize();
    process.on('SIGINT', shutdown);
});

program.command('add <number>').option('-p, --pairing').action(async (n, opt) => {
    await dbManager.initialize();
    await loadConfig();
    const id = await dbManager.addNumber(n);
    const num = await dbManager.getNumber(id);
    await addBot(num);
    await new Promise(() => {});
});

program.command('target')
    .option('-a, --add <n>')
    .option('-i, --import <f>')
    .option('-l, --list')
    .action(async (opt) => {
        await dbManager.initialize();
        if (opt.add) { await dbManager.addTarget(opt.add); console.log(`✅ ${opt.add}`); }
        else if (opt.import) { const c = await dbManager.importTargets(opt.import); console.log(`✅ ${c} targets`); }
        else if (opt.list) { console.table(await dbManager.getAllTargets()); }
        process.exit(0);
    });

program.command('status').action(async () => {
    await dbManager.initialize();
    console.log(await dbManager.getStats());
    process.exit(0);
});

program.command('keywords')
    .option('-a, --add <k>')
    .option('-l, --list')
    .action(async (opt) => {
        await dbManager.initialize();
        if (opt.add) { await dbManager.addKeyword(opt.add); console.log(`✅ ${opt.add}`); }
        else if (opt.list) { console.table(await dbManager.getAllKeywords()); }
        process.exit(0);
    });

program.parse();
