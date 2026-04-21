// Scheduler untuk Warming Up
const cron = require('node-cron');
const EventEmitter = require('events');

class Scheduler extends EventEmitter {
    constructor(db, aiService, config) {
        super();
        this.db = db;
        this.ai = aiService;
        this.config = config;
        this.bots = new Map();
        this.tasks = new Map();
        this.isRunning = false;
    }
    
    registerBot(numberId, bot) {
        this.bots.set(numberId, bot);
        console.log(`📋 Registered bot: ${bot.phoneNumber}`);
    }
    
    unregisterBot(numberId) {
        this.bots.delete(numberId);
    }
    
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        
        // Check every 10 minutes
        cron.schedule('*/10 * * * *', async () => {
            await this.checkAndExecuteWarming();
        });
        
        // Also run immediately on start
        setTimeout(() => this.checkAndExecuteWarming(), 5000);
        
        console.log('⏰ Scheduler started - Checking every 10 minutes');
    }
    
    stop() {
        this.isRunning = false;
        if (this.task) {
            this.task.stop();
        }
    }
    
    async checkAndExecuteWarming() {
        console.log(`\n📊 [Scheduler] Checking ${this.bots.size} bots for warming...`);
        
        let executed = 0;
        let skipped = 0;
        
        for (const [numberId, bot] of this.bots) {
            try {
                // Check if bot can chat
                const canChat = await bot.canSendChat();
                
                if (!canChat.allowed) {
                    skipped++;
                    console.log(`⏭️ [${bot.phoneNumber}] Skip: ${canChat.reason}`);
                    continue;
                }
                
                // Get target number
                const targetNumber = await this.getTargetNumber(numberId);
                if (!targetNumber) {
                    console.log(`⚠️ [${bot.phoneNumber}] No target available`);
                    continue;
                }
                
                // Get keyword
                let keywordData = await this.getKeyword();
                
                if (!keywordData) {
                    console.log(`🤖 [${bot.phoneNumber}] Generating AI keyword...`);
                    const result = await this.ai.generateKeyword();
                    keywordData = { 
                        keyword: result.keyword, 
                        type: 'ai',
                        model: result.model 
                    };
                    
                    // Save to database
                    await this.db.addAIKeyword(
                        result.keyword, 
                        result.prompt, 
                        result.model
                    );
                }
                
                // Send message
                const result = await bot.sendWarmingMessage(
                    targetNumber, 
                    keywordData.keyword,
                    keywordData.model || 'auto'
                );
                
                if (result.success) {
                    executed++;
                    this.emit('warming_sent', {
                        number: bot.phoneNumber,
                        target: targetNumber,
                        keyword: keywordData.keyword
                    });
                }
                
                // Delay between bots
                await this.sleep(2000);
                
            } catch (error) {
                console.error(`❌ [${bot.phoneNumber}] Scheduler error:`, error.message);
            }
        }
        
        console.log(`📈 [Scheduler] Cycle complete - Executed: ${executed}, Skipped: ${skipped}\n`);
        
        this.emit('cycle_complete', { executed, skipped, total: this.bots.size });
    }
    
    async getTargetNumber(excludeId) {
        // Get random active number from database
        const numbers = await this.db.db.all(`
            SELECT number FROM numbers 
            WHERE status = 'active' 
            AND id != ?
            ORDER BY RANDOM() 
            LIMIT 1
        `, [excludeId]);
        
        if (numbers.length > 0) {
            return numbers[0].number;
        }
        
        // Fallback target numbers
        const fallbacks = [
            '6281234567890',
            '6289876543210',
            '6285678901234'
        ];
        
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    async getKeyword() {
        return await this.db.getKeyword();
    }
    
    async forceWarmup(numberId) {
        const bot = this.bots.get(numberId);
        if (!bot) return null;
        
        const targetNumber = await this.getTargetNumber(numberId);
        const keyword = await this.getKeyword() || 
                       (await this.ai.generateKeyword()).keyword;
        
        return await bot.sendWarmingMessage(targetNumber, keyword);
    }
    
    getStatus() {
        const status = [];
        
        for (const [id, bot] of this.bots) {
            status.push({
                id,
                number: bot.phoneNumber,
                connected: bot.isConnected,
                canChat: bot.canSendChat(),
                status: bot.getStatus()
            });
        }
        
        return status;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = Scheduler;
