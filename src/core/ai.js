// AI Service - Multi Model Support
const axios = require('axios');

class AIService {
    constructor() {
        this.models = [
            'glm47flash',
            'gpt-o4-mini',
            'deepseekr1',
            'gptoss120b',
            'qwq32b',
            'phi2',
            'gemini-2.0-flash'
        ];
        
        this.endpoints = {
            glm47flash: 'https://api.siputzx.my.id/api/ai/glm47flash',
            'gpt-o4-mini': 'https://api.siputzx.my.id/api/ai/gpt-o4-mini',
            deepseekr1: 'https://api.siputzx.my.id/api/ai/deepseekr1',
            gptoss120b: 'https://api.siputzx.my.id/api/ai/gptoss120b',
            qwq32b: 'https://api.siputzx.my.id/api/ai/qwq32b',
            phi2: 'https://api.siputzx.my.id/api/ai/phi2',
            'gemini-2.0-flash': 'https://api.siputzx.my.id/api/ai/gemini-lite'
        };
        
        this.currentIndex = 0;
        this.prompts = [
            "Berikan 1 keyword sapaan formal dan santun dalam bahasa Indonesia",
            "Buat 1 kata sapaan singkat yang sopan untuk memulai percakapan",
            "Berikan 1 kalimat pembuka yang ramah dan baik",
            "Generate 1 greeting message sederhana dalam bahasa Indonesia",
            "Buat 1 sapaan hangat untuk kenalan baru",
            "Berikan 1 kata sapaan yang umum digunakan sehari-hari"
        ];
    }
    
    getNextModel() {
        const model = this.models[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.models.length;
        return model;
    }
    
    getRandomPrompt() {
        return this.prompts[Math.floor(Math.random() * this.prompts.length)];
    }
    
    async generateKeyword(customPrompt = null) {
        const model = this.getNextModel();
        const prompt = customPrompt || this.getRandomPrompt();
        let endpoint = this.endpoints[model] || this.endpoints.glm47flash;
        
        try {
            const params = {
                prompt: prompt,
                system: 'Anda adalah asisten yang menghasilkan keyword sapaan singkat, formal dan santun. Jawab hanya dengan 1-3 kata saja, tanpa penjelasan.',
                temperature: 0.7
            };
            
            if (model === 'gemini-2.0-flash') {
                params.model = 'gemini-2.0-flash-lite';
            }
            
            const response = await axios.get(endpoint, {
                params,
                timeout: 15000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'WU-Bot/2.0'
                }
            });
            
            let keyword = this.extractKeyword(response.data);
            
            if (keyword) {
                console.log(`🤖 [${model}] Generated: "${keyword}"`);
                return {
                    keyword,
                    model,
                    prompt,
                    success: true
                };
            }
            
        } catch (error) {
            console.error(`❌ [${model}] Error: ${error.message}`);
        }
        
        // Fallback
        return {
            keyword: this.getFallbackKeyword(),
            model: 'fallback',
            prompt,
            success: false
        };
    }
    
    extractKeyword(data) {
        let text = data?.response || data?.result || data?.data || data;
        
        if (typeof text === 'object') {
            text = JSON.stringify(text);
        }
        
        if (typeof text === 'string') {
            // Clean up the response
            text = text
                .replace(/[^\w\s]/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            
            // Take first 50 chars max
            text = text.substring(0, 50);
            
            // If too long, take first few words
            const words = text.split(' ');
            if (words.length > 5) {
                text = words.slice(0, 5).join(' ');
            }
            
            return text || null;
        }
        
        return null;
    }
    
    getFallbackKeyword() {
        const fallbacks = [
            'Halo', 'Assalamualaikum', 'Selamat pagi',
            'Selamat siang', 'Selamat sore', 'Selamat malam',
            'Apa kabar', 'Salam kenal', 'Hai', 'Permisi'
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    async generateBio() {
        const model = this.getNextModel();
        const endpoint = this.endpoints[model] || this.endpoints.glm47flash;
        
        try {
            const response = await axios.get(endpoint, {
                params: {
                    prompt: 'Buat bio WhatsApp singkat, positif, dan inspiratif maksimal 50 karakter',
                    system: 'Jawab singkat saja, maksimal 50 karakter.',
                    temperature: 0.8
                },
                timeout: 10000
            });
            
            let bio = response.data?.response || response.data?.result || '';
            bio = bio.substring(0, 50).trim();
            
            return bio || 'Selalu bersyukur 🙏';
            
        } catch (error) {
            const bios = [
                'Selalu ada untukmu 🤗',
                'Senyum itu ibadah 😊',
                'Hidup itu sederhana',
                'Bersyukur selalu 🙏',
                'Stay positive ✨'
            ];
            return bios[Math.floor(Math.random() * bios.length)];
        }
    }
    
    async chat(prompt, systemPrompt = null) {
        const model = this.getNextModel();
        const endpoint = this.endpoints[model] || this.endpoints.glm47flash;
        
        try {
            const params = {
                prompt,
                temperature: 0.7
            };
            
            if (systemPrompt) {
                params.system = systemPrompt;
            }
            
            const response = await axios.get(endpoint, { params, timeout: 30000 });
            return response.data?.response || response.data?.result || response.data;
            
        } catch (error) {
            console.error(`Chat error: ${error.message}`);
            return null;
        }
    }
    
    getModelList() {
        return this.models;
    }
    
    getCurrentModel() {
        return this.models[this.currentIndex];
    }
}

module.exports = AIService;
