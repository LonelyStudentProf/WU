// Advanced Logger Utility
const fs = require('fs').promises;
const path = require('path');
const pino = require('pino');
const pretty = require('pino-pretty');

class Logger {
    constructor(options = {}) {
        this.logDir = options.logDir || path.join(process.cwd(), 'data', 'logs');
        this.level = options.level || 'info';
        this.retentionDays = options.retentionDays || 7;
        this.enableConsole = options.enableConsole !== false;
        this.enableFile = options.enableFile !== false;
        
        this.streams = [];
        this.initialized = false;
    }
    
    async initialize() {
        if (this.initialized) return;
        
        // Create log directory
        await fs.mkdir(this.logDir, { recursive: true });
        
        // Setup streams
        if (this.enableConsole) {
            const consoleStream = pretty({
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
                messageFormat: '{msg}'
            });
            this.streams.push({ level: this.level, stream: consoleStream });
        }
        
        if (this.enableFile) {
            // Daily rotating file stream
            const date = new Date().toISOString().split('T')[0];
            const fileStream = pino.destination({
                dest: path.join(this.logDir, `${date}.log`),
                sync: false
            });
            this.streams.push({ level: 'trace', stream: fileStream });
            
            // Error file
            const errorStream = pino.destination({
                dest: path.join(this.logDir, `${date}-error.log`),
                sync: false
            });
            this.streams.push({ level: 'error', stream: errorStream });
        }
        
        this.pino = pino({
            level: this.level,
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                level: (label) => ({ level: label.toUpperCase() }),
                bindings: (bindings) => ({ pid: bindings.pid })
            }
        }, pino.multistream(this.streams));
        
        this.initialized = true;
        
        // Start cleanup job
        this.startCleanup();
    }
    
    startCleanup() {
        // Clean old logs every day
        setInterval(async () => {
            await this.cleanup();
        }, 86400000);
    }
    
    async cleanup() {
        try {
            const files = await fs.readdir(this.logDir);
            const cutoff = Date.now() - (this.retentionDays * 86400000);
            
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stats = await fs.stat(filePath);
                
                if (stats.mtimeMs < cutoff) {
                    await fs.unlink(filePath);
                    console.log(`🧹 Cleaned old log: ${file}`);
                }
            }
        } catch (error) {
            console.error('Log cleanup error:', error.message);
        }
    }
    
    log(level, message, data = {}) {
        if (!this.pino) {
            console.log(`[${level.toUpperCase()}] ${message}`, data);
            return;
        }
        
        const logData = {
            ...data,
            timestamp: new Date().toISOString()
        };
        
        this.pino[level](logData, message);
    }
    
    info(message, data = {}) {
        this.log('info', message, data);
    }
    
    warn(message, data = {}) {
        this.log('warn', message, data);
    }
    
    error(message, data = {}) {
        this.log('error', message, data);
    }
    
    debug(message, data = {}) {
        this.log('debug', message, data);
    }
    
    trace(message, data = {}) {
        this.log('trace', message, data);
    }
    
    fatal(message, data = {}) {
        this.log('fatal', message, data);
    }
    
    // Specialized logging methods
    chat(from, to, message, status = 'sent') {
        this.info(`Chat: ${from} → ${to}`, {
            type: 'chat',
            from,
            to,
            message: message.substring(0, 100),
            status,
            length: message.length
        });
    }
    
    connection(number, status, details = {}) {
        const emoji = status === 'connected' ? '✅' : status === 'disconnected' ? '❌' : '🔄';
        this.info(`${emoji} ${number}: ${status}`, {
            type: 'connection',
            number,
            status,
            ...details
        });
    }
    
    ai(model, action, result, duration = 0) {
        this.info(`🤖 ${model}: ${action}`, {
            type: 'ai',
            model,
            action,
            result: result?.substring(0, 100),
            duration
        });
    }
    
    system(event, data = {}) {
        this.info(`⚙️ System: ${event}`, {
            type: 'system',
            event,
            ...data
        });
    }
    
    warming(number, target, keyword, success = true) {
        const emoji = success ? '✅' : '❌';
        this.info(`${emoji} Warming: ${number} → ${target}`, {
            type: 'warming',
            number,
            target,
            keyword,
            success
        });
    }
    
    // Get logs
    async getLogs(date = null, level = null, limit = 100) {
        const targetDate = date || new Date().toISOString().split('T')[0];
        const logFile = path.join(this.logDir, `${targetDate}.log`);
        
        try {
            const content = await fs.readFile(logFile, 'utf8');
            const lines = content.trim().split('\n').filter(l => l);
            
            let logs = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return { raw: line };
                }
            });
            
            if (level) {
                logs = logs.filter(l => l.level === level);
            }
            
            return logs.slice(-limit);
        } catch (error) {
            return [];
        }
    }
    
    // Stream logs in real-time
    async tailLogs(callback, lines = 10) {
        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(this.logDir, `${date}.log`);
        
        let lastSize = 0;
        
        const check = async () => {
            try {
                const stats = await fs.stat(logFile);
                
                if (stats.size > lastSize) {
                    const content = await fs.readFile(logFile, 'utf8');
                    const newContent = content.slice(lastSize);
                    lastSize = stats.size;
                    
                    const newLines = newContent.trim().split('\n').filter(l => l);
                    for (const line of newLines) {
                        try {
                            callback(JSON.parse(line));
                        } catch {
                            callback({ raw: line });
                        }
                    }
                }
            } catch (error) {
                // File doesn't exist yet
            }
        };
        
        const interval = setInterval(check, 1000);
        await check();
        
        return () => clearInterval(interval);
    }
}

// Singleton instance
let loggerInstance = null;

async function getLogger(options = {}) {
    if (!loggerInstance) {
        loggerInstance = new Logger(options);
        await loggerInstance.initialize();
    }
    return loggerInstance;
}

module.exports = { Logger, getLogger };
