#!/usr/bin/env python3
import sqlite3
import asyncio
import aiohttp
import json
import random
import time
from datetime import datetime, timedelta
from typing import Optional, List, Dict
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class AIGenerator:
    """AI Keyword Generator with multiple models"""
    
    ENDPOINTS = {
        'glm47flash': 'https://api.siputzx.my.id/api/ai/glm47flash',
        'gpt-o4-mini': 'https://api.siputzx.my.id/api/ai/gpt-o4-mini',
        'deepseekr1': 'https://api.siputzx.my.id/api/ai/deepseekr1',
        'gptoss120b': 'https://api.siputzx.my.id/api/ai/gptoss120b',
        'qwq32b': 'https://api.siputzx.my.id/api/ai/qwq32b',
        'phi2': 'https://api.siputzx.my.id/api/ai/phi2',
        'gemini-2.0-flash': 'https://api.siputzx.my.id/api/ai/gemini-lite?model=gemini-2.0-flash-lite'
    }
    
    def __init__(self):
        self.current_model = 0
        self.models = list(self.ENDPOINTS.keys())
        self.session: Optional[aiohttp.ClientSession] = None
    
    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self
    
    async def __aexit__(self, *args):
        if self.session:
            await self.session.close()
    
    def get_next_model(self) -> str:
        model = self.models[self.current_model]
        self.current_model = (self.current_model + 1) % len(self.models)
        return model
    
    async def generate_keyword(self, prompt: str = None) -> str:
        if not prompt:
            prompts = [
                "Berikan 1 keyword sapaan formal dan santun dalam bahasa Indonesia",
                "Buat kata sapaan singkat yang sopan",
                "Berikan 1 kalimat pembuka percakapan yang baik",
                "Generate 1 greeting message yang ramah"
            ]
            prompt = random.choice(prompts)
        
        model = self.get_next_model()
        endpoint = self.ENDPOINTS.get(model, self.ENDPOINTS['glm47flash'])
        
        try:
            params = {
                'prompt': prompt,
                'system': 'Anda adalah asisten yang menghasilkan keyword sapaan singkat, formal dan santun. Jawab hanya dengan 1 kata atau frasa pendek.',
                'temperature': 0.7
            }
            
            if 'gemini' in endpoint:
                params['model'] = 'gemini-2.0-flash-lite'
            
            async with self.session.get(endpoint, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    keyword = data.get('response') or data.get('result') or str(data)
                    keyword = ''.join(c for c in keyword if c.isalnum() or c.isspace()).strip()[:50]
                    
                    if keyword:
                        logger.info(f"Generated keyword with {model}: {keyword}")
                        return keyword
                
        except Exception as e:
            logger.error(f"AI generation error with {model}: {e}")
        
        return self.get_fallback()
    
    def get_fallback(self) -> str:
        fallbacks = [
            'Halo', 'Assalamualaikum', 'Selamat pagi', 
            'Apa kabar?', 'Salam kenal', 'Hai'
        ]
        return random.choice(fallbacks)
    
    async def generate_batch(self, count: int = 10) -> List[str]:
        keywords = []
        for _ in range(count):
            kw = await self.generate_keyword()
            keywords.append(kw)
            await asyncio.sleep(0.5)
        return keywords


class ProxyManager:
    """Proxy rotation and time-based management"""
    
    def __init__(self, db_path: str = './data/proxy.db'):
        self.db_path = db_path
        self.active_proxy = None
        self.init_db()
    
    def init_db(self):
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS proxies (
                    id INTEGER PRIMARY KEY,
                    url TEXT UNIQUE,
                    start_time INTEGER,
                    end_time INTEGER,
                    usage_count INTEGER DEFAULT 0,
                    last_used TIMESTAMP,
                    is_active BOOLEAN DEFAULT 1
                )
            ''')
    
    def is_time_valid(self, start_hour: int, end_hour: int) -> bool:
        current_hour = datetime.now().hour
        if start_hour <= end_hour:
            return start_hour <= current_hour < end_hour
        else:
            return current_hour >= start_hour or current_hour < end_hour
    
    def get_active_proxy(self) -> Optional[str]:
        with sqlite3.connect(self.db_path) as conn:
            proxies = conn.execute(
                'SELECT url, start_time, end_time FROM proxies WHERE is_active = 1'
            ).fetchall()
            
            for url, start, end in proxies:
                if start is None or end is None or self.is_time_valid(start, end):
                    conn.execute(
                        'UPDATE proxies SET usage_count = usage_count + 1, last_used = CURRENT_TIMESTAMP WHERE url = ?',
                        (url,)
                    )
                    return url
        
        return None


class WarmupScheduler:
    """Main scheduler for warming up operations"""
    
    def __init__(self, numbers_db: str = './data/numbers.db', keywords_db: str = './data/keywords.db'):
        self.numbers_db = numbers_db
        self.keywords_db = keywords_db
        self.running = False
    
    async def get_ready_numbers(self) -> List[Dict]:
        with sqlite3.connect(self.numbers_db) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute('''
                SELECT * FROM numbers 
                WHERE status = 'active' 
                AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
            ''')
            return [dict(row) for row in cursor.fetchall()]
    
    async def get_keyword(self) -> Optional[str]:
        with sqlite3.connect(self.keywords_db) as conn:
            cursor = conn.execute('''
                SELECT keyword FROM keywords 
                ORDER BY usage_count ASC, RANDOM() 
                LIMIT 1
            ''')
            row = cursor.fetchone()
            
            if row:
                conn.execute(
                    'UPDATE keywords SET usage_count = usage_count + 1 WHERE keyword = ?',
                    (row[0],)
                )
                return row[0]
        
        return None
    
    async def update_cooldown(self, number_id: int):
        cooldown_time = (datetime.now() + timedelta(hours=3)).isoformat()
        with sqlite3.connect(self.numbers_db) as conn:
            conn.execute(
                'UPDATE numbers SET cooldown_until = ?, last_chat = datetime("now"), total_chats = total_chats + 1 WHERE id = ?',
                (cooldown_time, number_id)
            )
    
    async def run_cycle(self):
        """Run one warming up cycle"""
        numbers = await self.get_ready_numbers()
        
        if not numbers:
            logger.info("No numbers ready for warming up")
            return
        
        async with AIGenerator() as ai:
            for number in numbers[:10]:  # Process max 10 per cycle
                keyword = await self.get_keyword()
                
                if not keyword:
                    keyword = await ai.generate_keyword()
                    with sqlite3.connect(self.keywords_db) as conn:
                        conn.execute(
                            'INSERT OR IGNORE INTO keywords (keyword, type) VALUES (?, "ai")',
                            (keyword,)
                        )
                
                logger.info(f"Warming up {number['number']} with: {keyword}")
                await self.update_cooldown(number['id'])
                
                # Send to Node.js process via IPC or file
                self.notify_node(number['number'], keyword)
    
    def notify_node(self, number: str, keyword: str):
        """Notify Node.js process about warming up task"""
        task_file = Path('./data/tasks.jsonl')
        with open(task_file, 'a') as f:
            json.dump({
                'timestamp': datetime.now().isoformat(),
                'number': number,
                'keyword': keyword,
                'type': 'warming'
            }, f)
            f.write('\n')
    
    async def start(self):
        """Start the scheduler loop"""
        self.running = True
        logger.info("Warmup scheduler started")
        
        while self.running:
            try:
                await self.run_cycle()
                await asyncio.sleep(1800)  # Check every 30 minutes
            except Exception as e:
                logger.error(f"Scheduler error: {e}")
                await asyncio.sleep(60)
    
    def stop(self):
        self.running = False


async def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='WU Python Service')
    parser.add_argument('--mode', choices=['scheduler', 'generate', 'proxy'], default='scheduler')
    parser.add_argument('--count', type=int, default=10, help='Number of keywords to generate')
    
    args = parser.parse_args()
    
    if args.mode == 'scheduler':
        scheduler = WarmupScheduler()
        await scheduler.start()
    
    elif args.mode == 'generate':
        async with AIGenerator() as ai:
            keywords = await ai.generate_batch(args.count)
            for kw in keywords:
                print(kw)
    
    elif args.mode == 'proxy':
        proxy_mgr = ProxyManager()
        active = proxy_mgr.get_active_proxy()
        if active:
            print(f"Active proxy: {active}")
        else:
            print("No active proxy")

if __name__ == '__main__':
    asyncio.run(main())
