// WhatsApp Bot Class dengan Delay 2 Jam First Connect
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { HttpsProxyAgent } = require('https-proxy-agent');
const EventEmitter = require('events');

class WABot extends EventEmitter {
    constructor(numberId, phoneNumber, sessionPath, db, config = {}) {
        super();
        this.numberId = numberId;
        this.phoneNumber = phoneNumber;
        this.sessionPath = sessionPath;
        this.db = db;
        this.config = config;
        this.sock = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.firstConnectTime = null;
        this.isFirstConnect = true;
        this.pairingCode = null;
        this.qrCode = null;
    }
    
    async connect(usePairing = false) {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            
            const sockOptions = {
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: !usePairing,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                },
                browser: Browsers.ubuntu('Chrome'),
                markOnlineOnConnect: false, // Don't mark online immediately
                generateHighQualityLinkPreview: true,
                syncFullHistory: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 30000
            };
            
            // Check proxy
            if (this.config.proxy?.enabled && this.isProxyTimeValid()) {
                sockOptions.agent = new HttpsProxyAgent(this.config.proxy.url);
            }
            
            this.sock = makeWASocket(sockOptions);
            
            // Handle pairing code
            if (usePairing) {
                const cleanNumber = this.phoneNumber.replace(/\D/g, '');
                setTimeout(async () => {
                    try {
                        this.pairingCode = await this.sock.requestPairingCode(cleanNumber);
                        console.log(`📱 Pairing code for ${this.phoneNumber}: ${this.pairingCode}`);
                        this.emit('pairing', { number: this.phoneNumber, code: this.pairingCode });
                    } catch (error) {
                        console.error(`Pairing error: ${error.message}`);
                    }
                }, 3000);
            }
            
            // Handle credential updates
            this.sock.ev.on('creds.update', saveCreds);
            
            // Handle connection updates
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    this.qrCode = qr;
                    qrcode.generate(qr, { small: true });
                    this.emit('qr', { number: this.phoneNumber, qr });
                }
                
                if (connection === 'open') {
                    await this.handleConnectionOpen();
                }
                
                if (connection === 'close') {
                    await this.handleConnectionClose(lastDisconnect);
                }
            });
            
            // Handle messages
            this.sock.ev.on('messages.upsert', async (m) => {
                this.emit('message', { number: this.phoneNumber, message: m });
            });
            
            return this.sock;
            
        } catch (error) {
            console.error(`Connection error for ${this.phoneNumber}:`, error.message);
            this.emit('error', { number: this.phoneNumber, error: error.message });
            throw error;
        }
    }
    
    async handleConnectionOpen() {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        
        // Check if first connect
        const isFirst = await this.db.isFirstConnect(this.numberId);
        
        if (isFirst) {
            this.isFirstConnect = true;
            this.firstConnectTime = new Date();
            await this.db.updateFirstConnect(this.numberId);
            await this.db.updateNumberStatus(this.numberId, 'active');
            
            console.log(`✅ [${this.phoneNumber}] First connect - Waiting 2 hours before first chat`);
            this.emit('first_connect', { 
                number: this.phoneNumber, 
                nextChatIn: '2 hours' 
            });
            
            // Set cooldown untuk 2 jam ke depan
            await this.db.updateCooldown(this.numberId, 2);
            
        } else {
            this.isFirstConnect = false;
            await this.db.updateNumberStatus(this.numberId, 'active');
            
            const stats = await this.db.getChatStats(this.numberId);
            console.log(`✅ [${this.phoneNumber}] Reconnected - Total chats: ${stats?.total || 0}`);
        }
        
        this.emit('connected', { 
            number: this.phoneNumber, 
            isFirstConnect: this.isFirstConnect 
        });
        
        // Update bio if enabled
        if (this.config.bio?.enabled) {
            setTimeout(() => this.updateBio(), 5000);
        }
    }
    
    async handleConnectionClose(lastDisconnect) {
        this.isConnected = false;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && this.reconnectAttempts < (this.config.reconnectAttempts || 5)) {
            this.reconnectAttempts++;
            const delay = Math.min(5000 * this.reconnectAttempts, 60000);
            
            console.log(`🔄 [${this.phoneNumber}] Reconnecting in ${delay/1000}s (${this.reconnectAttempts}/${this.config.reconnectAttempts})`);
            
            setTimeout(() => {
                this.connect(this.config.pairingMode || false);
            }, delay);
            
        } else {
            await this.db.updateNumberStatus(this.numberId, 'disconnected');
            console.log(`❌ [${this.phoneNumber}] Disconnected permanently`);
            this.emit('disconnected', { number: this.phoneNumber });
        }
    }
    
    async updateBio() {
        try {
            const bio = await this.getBio();
            await this.sock.updateProfileStatus(bio);
            console.log(`📝 [${this.phoneNumber}] Bio updated: ${bio}`);
        } catch (error) {
            console.error(`Bio update failed: ${error.message}`);
        }
    }
    
    async getBio() {
        const bios = [
            'Selalu ada untukmu 🤗',
            'Senyum itu ibadah 😊',
            'Hidup itu sederhana',
            'Bersyukur selalu 🙏',
            'Stay positive ✨',
            'Just be yourself 🌟',
            'Keep smiling 😊'
        ];
        return bios[Math.floor(Math.random() * bios.length)];
    }
    
    async sendWarmingMessage(targetNumber, keyword, aiModel = 'auto') {
        try {
            // Check if can chat
            const canChat = await this.canSendChat();
            if (!canChat.allowed) {
                console.log(`⏳ [${this.phoneNumber}] Cannot chat yet: ${canChat.reason}`);
                return { success: false, reason: canChat.reason };
            }
            
            const formattedNumber = targetNumber.includes('@s.whatsapp.net') 
                ? targetNumber 
                : `${targetNumber.replace(/\D/g, '')}@s.whatsapp.net`;
            
            // Natural typing delay
            await this.sock.presenceSubscribe(formattedNumber);
            await this.sock.sendPresenceUpdate('composing', formattedNumber);
            
            const typingDelay = 2000 + Math.random() * 3000;
            await this.sleep(typingDelay);
            
            // Send message
            const message = await this.sock.sendMessage(formattedNumber, { 
                text: keyword 
            });
            
            await this.sock.sendPresenceUpdate('paused', formattedNumber);
            
            // Update database
            await this.db.addChatHistory(this.numberId, targetNumber, keyword, aiModel);
            await this.db.updateCooldown(this.numberId, 3); // 3 jam cooldown
            
            console.log(`✅ [${this.phoneNumber}] Sent to ${targetNumber}: "${keyword}"`);
            
            this.emit('message_sent', {
                from: this.phoneNumber,
                to: targetNumber,
                keyword,
                aiModel
            });
            
            return { 
                success: true, 
                message,
                keyword 
            };
            
        } catch (error) {
            console.error(`❌ [${this.phoneNumber}] Send failed:`, error.message);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }
    
    async canSendChat() {
        // Check if connected
        if (!this.isConnected || !this.sock) {
            return { allowed: false, reason: 'Not connected' };
        }
        
        // Check cooldown from database
        const number = await this.db.getNumber(this.numberId);
        
        if (number?.cooldown_until) {
            const cooldownUntil = new Date(number.cooldown_until);
            const now = new Date();
            
            if (cooldownUntil > now) {
                const remaining = Math.ceil((cooldownUntil - now) / 1000 / 60);
                return { 
                    allowed: false, 
                    reason: `Cooldown: ${remaining} minutes remaining` 
                };
            }
        }
        
        // Check first connect delay (2 jam)
        if (number?.first_connect) {
            const firstConnect = new Date(number.first_connect);
            const now = new Date();
            const hoursSince = (now - firstConnect) / (1000 * 60 * 60);
            
            if (hoursSince < 2) {
                const remaining = Math.ceil(120 - (hoursSince * 60));
                return { 
                    allowed: false, 
                    reason: `First connect delay: ${remaining} minutes remaining` 
                };
            }
        }
        
        return { allowed: true };
    }
    
    isProxyTimeValid() {
        if (!this.config.proxy?.enabled) return false;
        
        const now = new Date().getHours();
        const start = this.config.proxy.startTime || 0;
        const end = this.config.proxy.endTime || 0;
        
        if (start === end) return true;
        
        if (start < end) {
            return now >= start && now < end;
        } else {
            return now >= start || now < end;
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async disconnect() {
        if (this.sock) {
            try {
                await this.sock.logout();
            } catch (error) {
                console.error(`Logout error: ${error.message}`);
            }
            this.isConnected = false;
        }
    }
    
    getStatus() {
        return {
            number: this.phoneNumber,
            connected: this.isConnected,
            isFirstConnect: this.isFirstConnect,
            firstConnectTime: this.firstConnectTime,
            reconnectAttempts: this.reconnectAttempts,
            pairingCode: this.pairingCode,
            hasQR: !!this.qrCode
        };
    }
}

module.exports = WABot;
