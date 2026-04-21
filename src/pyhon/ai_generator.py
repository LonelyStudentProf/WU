import asyncio
import aiohttp
import random
import json
from typing import Dict, List, Optional, Any
from datetime import datetime


class AIGenerator:
    """AI Keyword Generator with multiple models"""
    
    ENDPOINTS = {
        'glm47flash': 'https://api.siputzx.my.id/api/ai/glm47flash',
        'gpt-o4-mini': 'https://api.siputzx.my.id/api/ai/gpt-o4-mini',
        'deepseekr1': 'https://api.siputzx.my.id/api/ai/deepseekr1',
        'gptoss120b': 'https://api.siputzx.my.id/api/ai/gptoss120b',
        'qwq32b': 'https://api.siputzx.my.id/api/ai/qwq32b',
        'phi2': 'https://api.siputzx.my.id/api/ai/phi2',
        'gemini-2.0-flash': 'https://api.siputzx.my.id/api/ai/gemini-lite'
    }
    
    PROMPTS = [
        "Berikan 1 keyword sapaan formal dan santun dalam bahasa Indonesia",
        "Buat 1 kata sapaan singkat yang sopan untuk memulai percakapan",
        "Berikan 1 kalimat pembuka yang ramah dan baik",
        "Generate 1 greeting message sederhana dalam bahasa Indonesia",
        "Buat 1 sapaan hangat untuk kenalan baru",
        "Berikan 1 kata sapaan yang umum digunakan sehari-hari",
        "Buat 1 kalimat pembuka percakapan yang natural",
        "Berikan 1 greeting singkat yang sopan",
        "Generate 1 kata sapaan formal",
        "Buat 1 kalimat sapaan yang friendly"
    ]
    
    FALLBACK_KEYWORDS = [
        'Halo', 'Assalamualaikum', 'Selamat pagi',
        'Selamat siang', 'Selamat sore', 'Selamat malam',
        'Apa kabar?', 'Salam kenal', 'Hai', 'Permisi',
        'Selamat beraktivitas', 'Semangat ya', 'Have a nice day'
    ]
    
    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        self.models = self.config.get('ai_models', list(self.ENDPOINTS.keys()))
        self.current_index = 0
        self.session: Optional[aiohttp.ClientSession] = None
        self.stats = {model: {'success': 0, 'fail': 0} for model in self.models}
    
    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create HTTP session"""
        if self.session is None or self.session.closed:
            timeout = aiohttp.ClientTimeout(total=30)
            self.session = aiohttp.ClientSession(timeout=timeout)
        return self.session
    
    async def close(self):
        """Close HTTP session"""
        if self.session and not self.session.closed:
            await self.session.close()
    
    def _get_next_model(self) -> str:
        """Get next model in rotation"""
        model = self.models[self.current_index]
        self.current_index = (self.current_index + 1) % len(self.models)
        return model
    
    def _get_random_prompt(self) -> str:
        """Get random prompt"""
        return random.choice(self.PROMPTS)
    
    def _clean_keyword(self, text: str) -> str:
        """Clean and format keyword"""
        if not text:
            return ""
        
        # Remove special characters
        import re
        text = re.sub(r'[^\w\s]', '', text)
        
        # Remove extra spaces
        text = ' '.join(text.split())
        
        # Limit length
        words = text.split()
        if len(words) > 5:
            text = ' '.join(words[:5])
        
        return text[:50].strip()
    
    async def generate_keyword(self, prompt: str = None) -> Dict[str, Any]:
        """Generate single keyword"""
        model = self._get_next_model()
        endpoint = self.ENDPOINTS.get(model, self.ENDPOINTS['glm47flash'])
        prompt_text = prompt or self._get_random_prompt()
        
        try:
            session = await self._get_session()
            
            params = {
                'prompt': prompt_text,
                'system': 'Anda adalah asisten yang menghasilkan keyword sapaan singkat, formal dan santun. Jawab hanya dengan 1-3 kata saja, tanpa penjelasan tambahan.',
                'temperature': 0.7
            }
            
            if model == 'gemini-2.0-flash':
                params['model'] = 'gemini-2.0-flash-lite'
            
            async with session.get(endpoint, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    
                    # Extract keyword from response
                    keyword = data.get('response') or data.get('result') or data.get('data')
                    
                    if isinstance(keyword, dict):
                        keyword = json.dumps(keyword)
                    elif keyword is None:
                        keyword = str(data)
                    
                    keyword = self._clean_keyword(str(keyword))
                    
                    if keyword:
                        self.stats[model]['success'] += 1
                        return {
                            'keyword': keyword,
                            'model': model,
                            'prompt': prompt_text,
                            'success': True,
                            'timestamp': datetime.now().isoformat()
                        }
                
                self.stats[model]['fail'] += 1
                
        except asyncio.TimeoutError:
            print(f"⚠️ Timeout for model {model}")
            self.stats[model]['fail'] += 1
        except Exception as e:
            print(f"❌ Error with {model}: {e}")
            self.stats[model]['fail'] += 1
        
        # Fallback
        return {
            'keyword': random.choice(self.FALLBACK_KEYWORDS),
            'model': 'fallback',
            'prompt': prompt_text,
            'success': False,
            'timestamp': datetime.now().isoformat()
        }
    
    async def generate_batch(self, count: int = 10) -> List[Dict[str, Any]]:
        """Generate multiple keywords"""
        tasks = [self.generate_keyword() for _ in range(count)]
        results = await asyncio.gather(*tasks)
        return results
    
    async def generate_with_all_models(self, prompt: str = None) -> List[Dict[str, Any]]:
        """Generate keyword using all models"""
        prompt_text = prompt or self._get_random_prompt()
        tasks = []
        
        for model in self.models:
            endpoint = self.ENDPOINTS.get(model)
            if endpoint:
                tasks.append(self._generate_with_model(model, endpoint, prompt_text))
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        valid_results = []
        for result in results:
            if isinstance(result, dict):
                valid_results.append(result)
        
        return valid_results
    
    async def _generate_with_model(self, model: str, endpoint: str, prompt: str) -> Dict[str, Any]:
        """Generate keyword with specific model"""
        try:
            session = await self._get_session()
            
            params = {
                'prompt': prompt,
                'system': 'Jawab hanya dengan 1-3 kata sapaan saja.',
                'temperature': 0.7
            }
            
            if 'gemini' in model:
                params['model'] = 'gemini-2.0-flash-lite'
            
            async with session.get(endpoint, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    keyword = data.get('response') or data.get('result') or str(data)
                    keyword = self._clean_keyword(str(keyword))
                    
                    if keyword:
                        self.stats[model]['success'] += 1
                        return {
                            'keyword': keyword,
                            'model': model,
                            'prompt': prompt,
                            'success': True,
                            'timestamp': datetime.now().isoformat()
                        }
                
                self.stats[model]['fail'] += 1
                
        except Exception as e:
            print(f"❌ Model {model} error: {e}")
            self.stats[model]['fail'] += 1
        
        return {
            'keyword': random.choice(self.FALLBACK_KEYWORDS),
            'model': model,
            'prompt': prompt,
            'success': False,
            'timestamp': datetime.now().isoformat()
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """Get generation statistics"""
        total_success = sum(s['success'] for s in self.stats.values())
        total_fail = sum(s['fail'] for s in self.stats.values())
        total = total_success + total_fail
        
        return {
            'models': self.stats,
            'total': total,
            'success_rate': (total_success / total * 100) if total > 0 else 0,
            'current_model': self.models[self.current_index] if self.models else None
        }
    
    def reset_stats(self):
        """Reset statistics"""
        self.stats = {model: {'success': 0, 'fail': 0} for model in self.models}


# CLI for testing
async def test_generator():
    """Test the AI generator"""
    generator = AIGenerator()
    
    print("🤖 Testing AI Generator...\n")
    
    # Single generation
    print("Single keyword generation:")
    result = await generator.generate_keyword()
    print(f"  Model: {result['model']}")
    print(f"  Keyword: {result['keyword']}")
    print(f"  Success: {result['success']}\n")
    
    # Batch generation
    print("Batch generation (3 keywords):")
    results = await generator.generate_batch(3)
    for i, r in enumerate(results, 1):
        print(f"  {i}. [{r['model']}] {r['keyword']}")
    
    # Stats
    print("\n📊 Statistics:")
    stats = generator.get_stats()
    for model, s in stats['models'].items():
        if s['success'] > 0 or s['fail'] > 0:
            print(f"  {model}: ✅ {s['success']} | ❌ {s['fail']}")
    print(f"  Success Rate: {stats['success_rate']:.1f}%")
    
    await generator.close()


if __name__ == '__main__':
    asyncio.run(test_generator())
