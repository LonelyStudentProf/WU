// Helper Utilities
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class Helper {
    /**
     * Sleep/delay function
     */
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Random sleep between min and max
     */
    static async randomSleep(min, max) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        return this.sleep(delay);
    }
    
    /**
     * Format phone number to international format
     */
    static formatPhoneNumber(number) {
        // Remove all non-digits
        let cleaned = number.replace(/\D/g, '');
        
        // Handle Indonesian numbers
        if (cleaned.startsWith('0')) {
            cleaned = '62' + cleaned.slice(1);
        } else if (cleaned.startsWith('8')) {
            cleaned = '62' + cleaned;
        }
        
        return cleaned;
    }
    
    /**
     * Format number for WhatsApp JID
     */
    static formatWhatsAppJID(number) {
        const cleaned = this.formatPhoneNumber(number);
        return `${cleaned}@s.whatsapp.net`;
    }
    
    /**
     * Generate random string
     */
    static randomString(length = 10) {
        return crypto.randomBytes(length).toString('hex').slice(0, length);
    }
    
    /**
     * Generate hash
     */
    static hash(data, algorithm = 'sha256') {
        return crypto.createHash(algorithm).update(data).digest('hex');
    }
    
    /**
     * Format timestamp to readable date
     */
    static formatDate(timestamp, format = 'datetime') {
        const date = timestamp ? new Date(timestamp) : new Date();
        
        const formats = {
            date: date.toLocaleDateString('id-ID'),
            time: date.toLocaleTimeString('id-ID'),
            datetime: date.toLocaleString('id-ID'),
            iso: date.toISOString(),
            relative: this.timeAgo(date)
        };
        
        return formats[format] || formats.datetime;
    }
    
    /**
     * Time ago formatter
     */
    static timeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        
        const intervals = [
            { label: 'tahun', seconds: 31536000 },
            { label: 'bulan', seconds: 2592000 },
            { label: 'hari', seconds: 86400 },
            { label: 'jam', seconds: 3600 },
            { label: 'menit', seconds: 60 },
            { label: 'detik', seconds: 1 }
        ];
        
        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                return `${count} ${interval.label} yang lalu`;
            }
        }
        
        return 'baru saja';
    }
    
    /**
     * Format duration
     */
    static formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}h ${hours % 24}j`;
        if (hours > 0) return `${hours}j ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}d`;
        return `${seconds}d`;
    }
    
    /**
     * Format bytes to human readable
     */
    static formatBytes(bytes) {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }
    
    /**
     * Get system info
     */
    static async getSystemInfo() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        
        return {
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            memory: {
                total: this.formatBytes(totalMem),
                used: this.formatBytes(usedMem),
                free: this.formatBytes(freeMem),
                usagePercent: ((usedMem / totalMem) * 100).toFixed(1)
            },
            uptime: this.formatDuration(os.uptime() * 1000),
            hostname: os.hostname(),
            nodeVersion: process.version
        };
    }
    
    /**
     * Retry function with exponential backoff
     */
    static async retry(fn, options = {}) {
        const {
            maxAttempts = 3,
            initialDelay = 1000,
            maxDelay = 30000,
            backoffFactor = 2,
            onRetry = null
        } = options;
        
        let attempt = 0;
        let delay = initialDelay;
        
        while (attempt < maxAttempts) {
            try {
                return await fn();
            } catch (error) {
                attempt++;
                
                if (attempt >= maxAttempts) {
                    throw error;
                }
                
                if (onRetry) {
                    onRetry(attempt, error, delay);
                }
                
                await this.sleep(delay);
                delay = Math.min(delay * backoffFactor, maxDelay);
            }
        }
    }
    
    /**
     * Chunk array
     */
    static chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
    
    /**
     * Shuffle array
     */
    static shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }
    
    /**
     * Pick random item from array
     */
    static randomItem(array) {
        return array[Math.floor(Math.random() * array.length)];
    }
    
    /**
     * Safe JSON parse
     */
    static safeJsonParse(str, defaultValue = null) {
        try {
            return JSON.parse(str);
        } catch {
            return defaultValue;
        }
    }
    
    /**
     * Deep merge objects
     */
    static deepMerge(target, source) {
        const output = { ...target };
        
        for (const key in source) {
            if (this.isObject(source[key]) && this.isObject(target[key])) {
                output[key] = this.deepMerge(target[key], source[key]);
            } else {
                output[key] = source[key];
            }
        }
        
        return output;
    }
    
    /**
     * Check if value is object
     */
    static isObject(item) {
        return item && typeof item === 'object' && !Array.isArray(item);
    }
    
    /**
     * Debounce function
     */
    static debounce(fn, delay) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), delay);
        };
    }
    
    /**
     * Throttle function
     */
    static throttle(fn, limit) {
        let inThrottle;
        return (...args) => {
            if (!inThrottle) {
                fn(...args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
    
    /**
     * Generate progress bar
     */
    static progressBar(current, total, length = 20) {
        const percent = current / total;
        const filled = Math.round(length * percent);
        const empty = length - filled;
        
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        const percentStr = (percent * 100).toFixed(1);
        
        return `${bar} ${percentStr}% (${current}/${total})`;
    }
    
    /**
     * Validate proxy URL
     */
    static validateProxy(proxyUrl) {
        try {
            const url = new URL(proxyUrl);
            return ['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol);
        } catch {
            return false;
        }
    }
    
    /**
     * Parse proxy from string
     */
    static parseProxy(proxyString) {
        try {
            const url = new URL(proxyString);
            return {
                protocol: url.protocol.replace(':', ''),
                host: url.hostname,
                port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
                auth: url.username ? {
                    username: url.username,
                    password: url.password
                } : null
            };
        } catch {
            return null;
        }
    }
    
    /**
     * Generate unique ID
     */
    static generateId(prefix = '') {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 10);
        return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
    }
    
    /**
     * Safe file write
     */
    static async safeWriteFile(filePath, content) {
        const tempPath = `${filePath}.tmp`;
        
        try {
            await fs.writeFile(tempPath, content);
            await fs.rename(tempPath, filePath);
        } catch (error) {
            try {
                await fs.unlink(tempPath);
            } catch {}
            throw error;
        }
    }
    
    /**
     * Check if port is available
     */
    static async isPortAvailable(port) {
        const net = require('net');
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(port);
        });
    }
    
    /**
     * Find available port
     */
    static async findAvailablePort(startPort, endPort = startPort + 100) {
        for (let port = startPort; port <= endPort; port++) {
            if (await this.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error(`No available port between ${startPort}-${endPort}`);
    }
}

module.exports = Helper;
