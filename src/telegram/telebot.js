// Telegram Bot Manager
const TelegramBot = require('node-telegram-bot-api');

class TelegramManager {
    constructor(db, wuSystem) {
        this.db = db;
        this.wuSystem = wuSystem;
        this.bot = null;
        this.authorizedUsers = new Set();
    }
    
    init(token) {
        if (!token) {
            console.log('⚠️ Telegram token not configured');
            return;
        }
        
        this.bot = new TelegramBot(token, { polling: true });
        
        // Commands
        this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
        this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
        this.bot.onText(/\/numbers/, (msg) => this.handleNumbers(msg));
        this.bot.onText(/\/add (.+)/, (msg, match) => this.handleAdd(msg, match));
        this.bot.onText(/\/stats/, (msg) => this.handleStats(msg));
        this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
        
        // Callback queries
        this.bot.on('callback_query', (query) => this.handleCallback(query));
        
        console.log('🤖 Telegram Bot initialized');
    }
    
    async handleStart(msg) {
        const chatId = msg.chat.id;
        this.authorizedUsers.add(chatId);
        
        const welcome = `
🤖 *WhatsApp Warming Up Bot*

Selamat datang! Bot ini terhubung dengan sistem WU.

Gunakan perintah berikut:
/status - Lihat status sistem
/numbers - Daftar nomor
/stats - Statistik lengkap
/add <nomor> - Tambah nomor baru
/help - Bantuan

_Cooldown: 3 jam per chat_
_First connect delay: 2 jam_
        `;
        
        await this.bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    }
    
    async handleStatus(msg) {
        const chatId = msg.chat.id;
        
        const status = await this.wuSystem.getStatus();
        const stats = status.stats;
        
        const message = `
📊 *System Status*

📱 *Numbers:*
• Total: ${stats.numbers.total}
• Active: ${stats.numbers.active}
• Pending: ${stats.numbers.pending}
• Disconnected: ${stats.numbers.disconnected}

💬 *Chats:*
• Total sent: ${stats.numbers.total_chats}

🔑 *Keywords:*
• Available: ${stats.keywords.total}
• Used: ${stats.keywords.total_used}

⏰ *Cooldown:* 3 hours
⏱️ *First Delay:* 2 hours
        `;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    
    async handleNumbers(msg) {
        const chatId = msg.chat.id;
        
        const numbers = await this.db.getAllNumbers();
        
        if (numbers.length === 0) {
            await this.bot.sendMessage(chatId, 'Belum ada nomor terdaftar.');
            return;
        }
        
        let message = '📋 *Registered Numbers*\n\n';
        
        for (const num of numbers.slice(0, 20)) {
            const stats = await this.db.getChatStats(num.id);
            const statusEmoji = {
                'active': '🟢',
                'pending': '🟡',
                'disconnected': '🔴'
            }[num.status] || '⚪';
            
            message += `${statusEmoji} \`${num.number}\`\n`;
            message += `   Chats: ${stats?.total || 0} | Last: ${num.last_chat || 'Never'}\n\n`;
        }
        
        if (numbers.length > 20) {
            message += `_...and ${numbers.length - 20} more_`;
        }
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    
    async handleAdd(msg, match) {
        const chatId = msg.chat.id;
        const number = match[1].trim();
        
        // Validate number format
        if (!number.match(/^\d+$/)) {
            await this.bot.sendMessage(chatId, '❌ Format nomor tidak valid. Gunakan angka saja.');
            return;
        }
        
        await this.bot.sendMessage(chatId, `⏳ Menambahkan nomor ${number}...`);
        
        try {
            // Add number with pairing mode for easier setup
            await this.wuSystem.addNewNumber(number, true);
            
            const keyboard = {
                inline_keyboard: [[
                    { text: '🔄 Refresh Status', callback_data: `status_${number}` }
                ]]
            };
            
            await this.bot.sendMessage(
                chatId,
                `✅ Nomor ${number} ditambahkan!\n\n` +
                `Mode: Pairing Code\n` +
                `Tunggu pairing code muncul di terminal.`,
                { reply_markup: keyboard }
            );
            
        } catch (error) {
            await this.bot.sendMessage(chatId, `❌ Gagal menambahkan: ${error.message}`);
        }
    }
    
    async handleStats(msg) {
        const chatId = msg.chat.id;
        
        const status = await this.wuSystem.getStatus();
        const bots = status.bots || [];
        
        let message = '📊 *Detailed Statistics*\n\n';
        
        for (const bot of bots) {
            const canChat = await bot.canSendChat?.() || { allowed: false };
            
            message += `📱 *${bot.number}*\n`;
            message += `   Status: ${bot.connected ? '🟢 Connected' : '🔴 Disconnected'}\n`;
            message += `   Can chat: ${canChat.allowed ? '✅ Yes' : `❌ ${canChat.reason}`}\n`;
            message += `   First connect: ${bot.firstConnect ? 'Yes' : 'No'}\n\n`;
        }
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
    
    async handleHelp(msg) {
        const chatId = msg.chat.id;
        
        const help = `
📚 *Bantuan WhatsApp Warming Up*

*Commands:*
/start - Mulai bot
/status - Status sistem
/numbers - List nomor
/stats - Statistik detail
/add <nomor> - Tambah nomor baru

*Fitur:*
• ⏰ Cooldown 3 jam per chat
• ⏱️ Delay 2 jam saat first connect
• 🤖 7 AI Models (auto-rotate)
• 🔑 Auto-generate keywords
• 📊 Real-time monitoring
• 🔄 Auto-reconnect

*Setup Nomor Baru:*
1. /add 628xxxxxxx
2. Scan QR atau masukkan pairing code
3. Tunggu 2 jam untuk chat pertama
4. Sistem akan auto warming setiap 3 jam

*Info:* Sistem ini menggunakan multiple AI models untuk menghasilkan keyword sapaan yang natural.
        `;
        
        await this.bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
    }
    
    async handleCallback(query) {
        const chatId = query.message.chat.id;
        const data = query.data;
        
        if (data.startsWith('status_')) {
            const number = data.replace('status_', '');
            
            const numData = await this.db.getNumberByPhone(number);
            if (numData) {
                const stats = await this.db.getChatStats(numData.id);
                
                await this.bot.sendMessage(
                    chatId,
                    `📱 *${number}*\n` +
                    `Status: ${numData.status}\n` +
                    `Total chats: ${stats?.total || 0}\n` +
                    `Last chat: ${numData.last_chat || 'Never'}`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
        
        await this.bot.answerCallbackQuery(query.id);
    }
    
    async sendNotification(message, chatId = null) {
        if (!this.bot) return;
        
        const targetChat = chatId || this.config.telegram?.chatId;
        if (targetChat) {
            await this.bot.sendMessage(targetChat, message);
        }
    }
}

module.exports = TelegramManager;
