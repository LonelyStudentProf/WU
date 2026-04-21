// Monitoring Dashboard
const blessed = require('blessed');
const contrib = require('blessed-contrib');

class MonitorDashboard {
    constructor(db) {
        this.db = db;
        this.screen = null;
        this.grid = null;
        this.components = {};
        this.data = {
            numbers: [],
            logs: [],
            stats: {}
        };
        this.updateInterval = null;
    }
    
    init() {
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'WhatsApp Warming Up System v2.0',
            dockBorders: true,
            fullUnicode: true
        });
        
        this.grid = new contrib.grid({ 
            rows: 12, 
            cols: 12, 
            screen: this.screen 
        });
        
        this.createComponents();
        this.setupKeyBindings();
        
        // Start update loop
        this.updateInterval = setInterval(() => {
            this.updateDisplay();
        }, 3000);
        
        this.screen.render();
    }
    
    createComponents() {
        // Header
        this.components.header = this.grid.set(0, 0, 1, 12, blessed.box, {
            content: '📱 WHATSAPP WARMING UP SYSTEM',
            tags: true,
            style: {
                fg: 'white',
                bg: 'blue',
                bold: true
            }
        });
        
        // Stats box
        this.components.stats = this.grid.set(1, 0, 2, 12, blessed.box, {
            label: '📊 System Statistics',
            tags: true,
            border: { type: 'line' },
            style: { border: { fg: 'cyan' } }
        });
        
        // Numbers table
        this.components.table = this.grid.set(3, 0, 5, 8, contrib.table, {
            keys: true,
            fg: 'white',
            selectedFg: 'white',
            selectedBg: 'blue',
            label: '📋 Active Numbers',
            columnSpacing: 2,
            columnWidth: [16, 8, 8, 10, 12]
        });
        
        // AI Models status
        this.components.aiStatus = this.grid.set(3, 8, 2, 4, blessed.box, {
            label: '🤖 AI Models',
            tags: true,
            border: { type: 'line' },
            style: { border: { fg: 'green' } }
        });
        
        // Cooldown gauge
        this.components.cooldown = this.grid.set(5, 8, 3, 4, contrib.gauge, {
            label: '⏰ Global Cooldown Status',
            percent: 0
        });
        
        // Log box
        this.components.log = this.grid.set(8, 0, 4, 12, contrib.log, {
            fg: 'green',
            selectedFg: 'green',
            label: '📝 System Logs',
            bufferLength: 50
        });
    }
    
    setupKeyBindings() {
        this.screen.key(['escape', 'q', 'C-c'], () => {
            this.destroy();
        });
        
        this.screen.key(['r'], () => {
            this.refresh();
        });
        
        // Table navigation
        this.components.table.focus();
        this.screen.key(['up', 'down'], () => {
            // Handle table navigation
        });
    }
    
    async updateDisplay() {
        try {
            // Update stats
            const stats = await this.db.getSystemStats();
            
            this.components.stats.setContent(`
{cyan-fg}Total Numbers:{/cyan-fg} {white-fg}${stats.numbers.total}{/white-fg}
{cyan-fg}Active:{/cyan-fg} {green-fg}${stats.numbers.active}{/green-fg} {cyan-fg}Pending:{/cyan-fg} {yellow-fg}${stats.numbers.pending}{/yellow-fg} {cyan-fg}Disconnected:{/cyan-fg} {red-fg}${stats.numbers.disconnected}{/red-fg}
{cyan-fg}Total Chats Sent:{/cyan-fg} {white-fg}${stats.numbers.total_chats}{/white-fg}
{cyan-fg}Keywords Available:{/cyan-fg} {white-fg}${stats.keywords.total}{/white-fg} {cyan-fg}Used:{/cyan-fg} {white-fg}${stats.keywords.total_used}{/white-fg}
            `);
            
            // Update numbers table
            const numbers = await this.db.getAllNumbers();
            const tableData = {
                headers: ['Number', 'Status', 'Chats', 'Cooldown', 'Last Chat'],
                data: numbers.slice(0, 15).map(n => [
                    n.number.slice(-12),
                    this.formatStatus(n.status),
                    n.total_chats.toString(),
                    this.formatCooldown(n.cooldown_until),
                    this.formatTime(n.last_chat)
                ])
            };
            
            this.components.table.setData(tableData);
            
            // Update AI status
            this.components.aiStatus.setContent(`
{green-fg}✓ glm47flash{/green-fg}     {yellow-fg}⟳ gpt-o4-mini{/yellow-fg}
{green-fg}✓ deepseekr1{/green-fg}     {green-fg}✓ gptoss120b{/green-fg}
{green-fg}✓ qwq32b{/green-fg}         {yellow-fg}⟳ phi2{/yellow-fg}
{green-fg}✓ gemini-2.0-flash{/green-fg}

{cyan-fg}Rotation: {/cyan-fg}Round-robin (3h cooldown)
            `);
            
            this.screen.render();
            
        } catch (error) {
            this.log(`Update error: ${error.message}`, 'error');
        }
    }
    
    formatStatus(status) {
        const icons = {
            'active': '🟢 Active',
            'pending': '🟡 Pending',
            'disconnected': '🔴 Disc',
            'cooling': '⏳ Cool'
        };
        return icons[status] || status;
    }
    
    formatCooldown(cooldownUntil) {
        if (!cooldownUntil) return 'Ready';
        
        const until = new Date(cooldownUntil);
        const now = new Date();
        
        if (until <= now) return 'Ready';
        
        const minutes = Math.ceil((until - now) / 60000);
        return `${minutes}m left`;
    }
    
    formatTime(timestamp) {
        if (!timestamp) return 'Never';
        
        const date = new Date(timestamp);
        const now = new Date();
        const diff = Math.floor((now - date) / 60000);
        
        if (diff < 60) return `${diff}m ago`;
        if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
        return `${Math.floor(diff/1440)}d ago`;
    }
    
    log(message, type = 'info') {
        const colors = {
            info: '{green-fg}',
            warn: '{yellow-fg}',
            error: '{red-fg}',
            success: '{cyan-fg}'
        };
        
        const timestamp = new Date().toLocaleTimeString();
        const formattedMsg = `${colors[type]}[${timestamp}] ${message}{/}`;
        
        this.components.log.log(formattedMsg);
        this.screen.render();
    }
    
    refresh() {
        this.updateDisplay();
        this.log('Display refreshed', 'info');
    }
    
    destroy() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        if (this.screen) {
            this.screen.destroy();
        }
        process.exit(0);
    }
}

module.exports = MonitorDashboard;
