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

// ==================== CONFIGURATION ====================
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

const FALLBACK_KEYWORDS = ['Halo', 'Assalamualaikum', 'Selamat pagi', 'Apa kabar?', 'Salam kenal', 'Hai', 'Permisi'];
const FALLBACK_BIOS = ['✨ Selalu ada untukmu', '😊 Senyum itu ibadah', '🌟 Hidup itu sederhana', '🙏 Bersyukur selalu', '💪 Stay positive', '🌈 Just be yourself', '🎯 Keep going'];

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
    formatPhone: (n) => n.replace(/\D/g, ''),
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
                last_used TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chat_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number_id INTEGER,
                target_number TEXT,
                keyword TEXT,
                ai_model TEXT,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_numbers_status ON numbers(status);
        `);
        
        kwDb = await open({ filename: './data/keywords.db', driver: sqlite3.Database });
        await kwDb.exec(`
            CREATE TABLE IF NOT EXISTS keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword TEXT UNIQUE NOT NULL,
                usage_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    async getNumberByPhone(n) { return await db.get('SELECT * FROM numbers WHERE number = ?', [n]); }
    async getAllActiveNumbers() { return await db.all("SELECT * FROM numbers WHERE status = 'active'"); }
    async getAllNumbers() { return await db.all('SELECT * FROM numbers ORDER BY created_at DESC'); }
    async updateNumberStatus(id, s) { await db.run('UPDATE numbers SET status = ? WHERE id = ?', [s, id]); }
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
    
    async addTarget(n, name = null) { await db.run('INSERT OR IGNORE INTO targets (number, name) VALUES (?, ?)', [n, name]); }
    async getRandomTarget(exclude = null) {
        let q = 'SELECT number FROM targets WHERE status = "active"';
        const p = [];
        if (exclude) { q += ' AND number != ?'; p.push(exclude); }
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
                params: { 
                    prompt: 'Berikan 1 kata sapaan singkat sopan dalam bahasa Indonesia', 
                    system: 'Jawab hanya 1-3 kata saja, tanpa penjelasan', 
                    temperature: 0.7 
                },
                timeout: 15000
            });
            let kw = r.data?.response || r.data?.result || '';
            kw = String(kw).replace(/[^\w\s]/g, '').trim().substring(0, 30);
            return kw || Helper.randomItem(FALLBACK_KEYWORDS);
        } catch { 
            return Helper.randomItem(FALLBACK_KEYWORDS); 
        }
    }
    
    async generateBio() {
        const model = this.getNextModel();
        const endpoint = AI_ENDPOINTS[model] || AI_ENDPOINTS.glm47flash;
        try {
            const r = await axios.get(endpoint, {
                params: { 
                    prompt: 'Buat bio WhatsApp singkat, positif, dan inspiratif maksimal 30 karakter', 
                    system: 'Jawab singkat saja, maksimal 30 karakter', 
                    temperature: 0.8 
                },
                timeout: 10000
            });
            let bio = r.data?.response || r.data?.result || '';
            bio = String(bio).replace(/[^\w\s.,!?😊✨🌟💪🙏]/g, '').trim().substring(0, 30);
            return bio || Helper.randomItem(FALLBACK_BIOS);
        } catch { 
            return Helper.randomItem(FALLBACK_BIOS); 
        }
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
    }
    
    async connect(usePairing = false) {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            const opts = {
                version, 
                logger: pino({ level: 'silent' }), 
                printQRInTerminal: !usePairing,
                auth: { 
                    creds: state.creds, 
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) 
                },
                browser: Browsers.ubuntu('Chrome'), 
                markOnlineOnConnect: false
            };
            
            if (CONFIG.proxy.enabled) opts.agent = new HttpsProxyAgent(CONFIG.proxy.url);
            
            this.sock = makeWASocket(opts);
            
            // FIX: Pairing code dengan delay yang tepat
            if (usePairing) {
                setTimeout(async () => {
                    if (!this.sock.authState.creds.registered) {
                        try {
                            const phoneNumber = Helper.formatPhone(this.number);
                            const code = await this.sock.requestPairingCode(phoneNumber);
                            console.log('\n' + '='.repeat(40));
                            console.log(`📱 PAIRING CODE: ${code}`);
                            console.log('='.repeat(40));
                            console.log('Buka WhatsApp > Linked Devices > Link with phone number\n');
                        } catch (e) {
                            console.log('⚠️ Pairing code failed, scan QR instead');
                        }
                    }
                }, 5000); // Delay 5 detik
            }
            
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('connection.update', async (u) => {
                const { connection, lastDisconnect, qr } = u;
                
                if (qr && !usePairing) {
                    qrcode.generate(qr, { small: true });
                }
                
                if (connection === 'open') await this.onOpen();
                if (connection === 'close') await this.onClose(lastDisconnect);
            });
            
            return this.sock;
        } catch (e) { 
            logger.error(`Connect error: ${e.message}`); 
            throw e; 
        }
    }
    
    async onOpen() {
        this.connected = true;
        this.reconnectAttempts = 0;
        
        const isFirst = await dbManager.isFirstConnect(this.id);
        if (isFirst) {
            await dbManager.updateFirstConnect(this.id);
            await dbManager.updateNumberStatus(this.id, 'active');
            await dbManager.updateCooldown(this.id, CONFIG.firstConnectDelay);
            console.log(`\n✅ [${this.number}] First connect! Waiting ${CONFIG.firstConnectDelay}h before first chat.\n`);
        } else {
            await dbManager.updateNumberStatus(this.id, 'active');
            console.log(`✅ [${this.number}] Connected!`);
        }
        
        // FIX: Update bio dengan delay yang cukup
        if (CONFIG.bio.enabled && CONFIG.bio.autoUpdate) {
            setTimeout(async () => {
                await this.updateBio();
            }, 8000); // Delay 8 detik
        }
        
        this.emit('connected', { number: this.number });
    }
    
    async onClose(lastDisconnect) {
        this.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && this.reconnectAttempts < CONFIG.reconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(5000 * this.reconnectAttempts, 60000);
            console.log(`🔄 [${this.number}] Reconnecting in ${delay/1000}s...`);
            setTimeout(() => this.connect(CONFIG.pairingMode), delay);
        } else {
            await dbManager.updateNumberStatus(this.id, 'disconnected');
            console.log(`❌ [${this.number}] Disconnected`);
        }
    }
    
    // FIX: Method updateBio yang benar
    async updateBio() {
        try {
            let bio = await this.ai.generateBio();
            
            // Coba beberapa method untuk update bio
            try {
                await this.sock.updateProfileStatus(bio);
            } catch {
                // Fallback method
                await this.sock.updateProfileStatus({ status: bio });
            }
            
            await dbManager.updateBio(this.id, bio);
            console.log(`📝 [${this.number}] Bio updated: "${bio}"`);
            
        } catch (error) {
            console.log(`⚠️ [${this.number}] Bio update failed: ${error.message}`);
            // Fallback ke bio manual
            const manualBio = Helper.randomItem(FALLBACK_BIOS);
            try {
                await this.sock.updateProfileStatus(manualBio);
                await dbManager.updateBio(this.id, manualBio);
                console.log(`📝 [${this.number}] Bio updated (fallback): "${manualBio}"`);
            } catch {
                // Abaikan jika tetap gagal
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
        
        try {
            const jid = target.includes('@s.whatsapp.net') ? target : `${Helper.formatPhone(target)}@s.whatsapp.net`;
            
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
        if (this.sock) {
            try { await this.sock.logout(); } catch(e) {}
            this.connected = false;
        }
    }
    
    getStatus() { 
        return { number: this.number, connected: this.connected, attempts: this.reconnectAttempts }; 
    }
}

// ==================== SCHEDULER ====================
class Scheduler extends EventEmitter {
    start() {
        cron.schedule('*/5 * * * *', async () => await this.run());
        setTimeout(() => this.run(), 5000);
        console.log('⏰ Scheduler started (check every 5 min)');
    }
    
    async run() {
        let sent = 0;
        for (const [id, bot] of activeBots) {
            const can = await bot.canSend();
            if (!can.ok) continue;
            
            let target = await dbManager.getRandomTarget(bot.number);
            if (!target) {
                const nums = await db.all('SELECT number FROM numbers WHERE status = "active" AND id != ? ORDER BY RANDOM() LIMIT 1', [id]);
                target = nums[0]?.number || '6281234567890';
            }
            
            let kw = await dbManager.getKeyword();
            if (!kw) kw = await new AIService().generateKeyword();
            
            const r = await bot.sendMessage(target, kw);
            if (r.success) { 
                sent++; 
                this.emit('sent', { number: bot.number, target, keyword: kw });
                if (monitorDashboard) monitorDashboard.log(`✅ ${bot.number} → ${target}: "${kw}"`);
            }
            
            await Helper.sleep(3000);
        }
        if (sent > 0) console.log(`📊 Cycle complete - ${sent} messages sent`);
    }
}

const scheduler = new Scheduler();

// ==================== MONITOR DASHBOARD ====================
class Monitor {
    init() {
        this.screen = blessed.screen({ smartCSR: true, title: 'WU System v2.1' });
        this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });
        
        this.stats = this.grid.set(0, 0, 2, 12, blessed.box, { 
            label: '📊 System Statistics', 
            tags: true, 
            border: { type: 'line' },
            style: { border: { fg: 'cyan' } }
        });
        
        this.table = this.grid.set(2, 0, 5, 12, contrib.table, {
            keys: true, fg: 'white', selectedBg: 'blue', 
            label: '📱 Active Numbers',
            columnWidth: [16, 8, 6, 10, 12]
        });
        
        this.log = this.grid.set(7, 0, 5, 12, contrib.log, { 
            fg: 'green', 
            label: '📝 System Logs',
            bufferLength: 50 
        });
        
        this.screen.key(['q', 'C-c', 'escape'], () => { 
            this.destroy(); 
            process.exit(0); 
        });
        
        this.interval = setInterval(() => this.update(), 3000);
        this.screen.render();
    }
    
    async update() {
        try {
            const s = await dbManager.getStats();
            this.stats.setContent(`
{cyan-fg}Numbers:{/cyan-fg} Total: {white-fg}${s.numbers.total}{/white-fg} | Active: {green-fg}${s.numbers.active}{/white-fg} | Chats: {white-fg}${s.numbers.chats}{/white-fg}
{cyan-fg}Targets:{/cyan-fg} {white-fg}${s.targets.total}{/white-fg} | {cyan-fg}Keywords:{/cyan-fg} {white-fg}${s.keywords.total}{/white-fg} (Used: ${s.keywords.used})
{cyan-fg}Settings:{/cyan-fg} Cooldown: ${CONFIG.cooldown}h | First Delay: ${CONFIG.firstConnectDelay}h | AI Models: ${CONFIG.aiModels.length}
            `);
            
            const nums = await db.all('SELECT number, status, total_chats, last_chat, bio FROM numbers LIMIT 15');
            this.table.setData({
                headers: ['Number', 'Status', 'Chats', 'Last Chat', 'Bio'],
                data: nums.map(n => [
                    n.number.slice(-12), 
                    n.status === 'active' ? '🟢' : '🔴',
                    String(n.total_chats), 
                    Helper.timeAgo(n.last_chat),
                    (n.bio || '-').substring(0, 10)
                ])
            });
            this.screen.render();
        } catch(e) {}
    }
    
    log(msg) { 
        this.log.log(`[${new Date().toLocaleTimeString()}] ${msg}`); 
        this.screen.render(); 
    }
    
    destroy() { 
        clearInterval(this.interval); 
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
                '🤖 *WhatsApp WU Bot*\n\n' +
                '/status - System status\n' +
                '/numbers - List numbers\n' +
                '/targets - List targets\n' +
                '/add <number> - Add number\n' +
                '/target <number> - Add target',
                { parse_mode: 'Markdown' }
            );
        });
        
        telegramBot.onText(/\/status/, async (msg) => {
            const s = await dbManager.getStats();
            telegramBot.sendMessage(msg.chat.id, 
                `📊 *Status*\n• Numbers: ${s.numbers.total} (Active: ${s.numbers.active})\n• Targets: ${s.targets.total}\n• Total Chats: ${s.numbers.chats}\n• Cooldown: ${CONFIG.cooldown}h`,
                { parse_mode: 'Markdown' }
            );
        });
        
        telegramBot.onText(/\/numbers/, async (msg) => {
            const nums = await dbManager.getAllNumbers();
            let txt = '📱 *Numbers*\n\n';
            nums.slice(0, 15).forEach(n => { txt += `${n.status === 'active' ? '🟢' : '🔴'} ${n.number} | Chats: ${n.total_chats}\n`; });
            telegramBot.sendMessage(msg.chat.id, txt);
        });
        
        telegramBot.onText(/\/targets/, async (msg) => {
            const t = await dbManager.getAllTargets();
            let txt = '🎯 *Targets*\n\n';
            t.slice(0, 20).forEach(t => { txt += `📞 ${t.number} | Used: ${t.usage_count}\n`; });
            telegramBot.sendMessage(msg.chat.id, txt);
        });
        
        telegramBot.onText(/\/add (.+)/, async (msg, match) => {
            await dbManager.addNumber(match[1]);
            telegramBot.sendMessage(msg.chat.id, `✅ Added ${match[1]}. Run \`node index.js add ${match[1]} --pairing\` to connect.`);
        });
        
        telegramBot.onText(/\/target (.+)/, async (msg, match) => {
            await dbManager.addTarget(match[1]);
            telegramBot.sendMessage(msg.chat.id, `✅ Target ${match[1]} added`);
        });
        
        console.log('🤖 Telegram Bot ready');
    }
}

// ==================== MAIN SYSTEM ====================
async function loadConfig() {
    try { 
        CONFIG = { ...CONFIG, ...JSON.parse(await fs.readFile('./config.json', 'utf8')) }; 
    } catch { 
        await fs.writeFile('./config.json', JSON.stringify(CONFIG, null, 2)); 
    }
}

async function addBot(numData) {
    const sessionPath = path.join(process.cwd(), 'sessions', Helper.formatPhone(numData.number));
    const bot = new WABot(numData.id, numData.number, sessionPath);
    
    bot.on('connected', () => {
        if (monitorDashboard) monitorDashboard.log(`✅ ${numData.number} connected`);
    });
    
    activeBots.set(numData.id, bot);
    
    try {
        await bot.connect(CONFIG.pairingMode);
    } catch (e) {
        console.error(`Failed to connect ${numData.number}:`, e.message);
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
    console.log('\n🚀 WhatsApp Warming Up System v2.1\n');
    
    await dbManager.initialize();
    await loadConfig();
    
    if (CONFIG.telegram?.enabled) {
        new TelegramManager().init(CONFIG.telegram.token);
    }
    
    monitorDashboard = new Monitor();
    
    scheduler.on('sent', (data) => {
        console.log(`📤 ${data.number} → ${data.target}: "${data.keyword}"`);
    });
    
    await loadNumbers();
    
    scheduler.start();
    monitorDashboard.init();
    
    console.log('\n✨ System Ready!\n');
    console.log('Commands: node index.js add <number> [--pairing]');
    console.log('         node index.js target --add <number>');
    console.log('         node index.js status\n');
}

async function shutdown() {
    console.log('\n🛑 Shutting down...');
    for (const [id, bot] of activeBots) {
        await bot.disconnect();
    }
    if (monitorDashboard) monitorDashboard.destroy();
    process.exit(0);
}

// ==================== CLI ====================
const program = require('commander');

program.version('2.1.0').description('WhatsApp WU System');

program.command('start').description('Start system').action(async () => {
    await initialize();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
});

program.command('add <number>').description('Add number').option('-p, --pairing', 'Use pairing code').action(async (n, opt) => {
    await dbManager.initialize();
    await loadConfig();
    const id = await dbManager.addNumber(n);
    const num = await dbManager.getNumber(id);
    const bot = await addBot(num);
    console.log(`✅ Added ${n}. ${opt.pairing ? 'Waiting pairing code...' : 'Scan QR!'}`);
    await new Promise(() => {});
});

program.command('target').description('Manage targets')
    .option('-a, --add <number>', 'Add target')
    .option('-i, --import <file>', 'Import from file')
    .option('-l, --list', 'List targets')
    .action(async (opt) => {
        await dbManager.initialize();
        if (opt.add) { await dbManager.addTarget(opt.add); console.log(`✅ Target: ${opt.add}`); }
        else if (opt.import) { const c = await dbManager.importTargets(opt.import); console.log(`✅ Imported ${c} targets`); }
        else if (opt.list) { const t = await dbManager.getAllTargets(); console.table(t.slice(0, 20)); }
        process.exit(0);
    });

program.command('status').description('Show status').action(async () => {
    await dbManager.initialize();
    const s = await dbManager.getStats();
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
});

program.command('keywords')
    .option('-a, --add <kw>', 'Add keyword')
    .option('-l, --list', 'List keywords')
    .option('-g, --generate', 'Generate AI keyword')
    .action(async (opt) => {
        await dbManager.initialize();
        if (opt.add) { await dbManager.addKeyword(opt.add); console.log(`✅ ${opt.add}`); }
        else if (opt.list) { const k = await dbManager.getAllKeywords(); console.table(k.slice(0, 30)); }
        else if (opt.generate) { const ai = new AIService(); console.log(`🤖 ${await ai.generateKeyword()}`); }
        process.exit(0);
    });

program.parse(process.argv);
