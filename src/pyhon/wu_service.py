import asyncio
import json
import signal
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any

from ai_generator import AIGenerator
from proxy_manager import ProxyManager

class WUService:
    """Main Warming Up Service"""
    
    def __init__(self, config_path: str = "./config.json"):
        self.config_path = Path(config_path)
        self.config = self.load_config()
        self.ai_generator = None
        self.proxy_manager = None
        self.running = False
        self.tasks = []
        
        # Data paths
        self.data_dir = Path("./data")
        self.task_file = self.data_dir / "tasks.jsonl"
        self.keyword_file = self.data_dir / "keywords.jsonl"
        
        # Setup
        self.data_dir.mkdir(parents=True, exist_ok=True)
    
    def load_config(self) -> Dict[str, Any]:
        """Load configuration"""
        default_config = {
            "cooldown": 3,
            "ai_models": [
                "glm47flash", "gpt-o4-mini", "deepseekr1",
                "gptoss120b", "qwq32b", "phi2", "gemini-2.0-flash"
            ],
            "proxy": {
                "enabled": False,
                "url": "",
                "start_time": 0,
                "end_time": 0
            },
            "keywords": {
                "auto_generate": True,
                "max_ai_keywords": 100,
                "fallback_keywords": [
                    "Halo", "Assalamualaikum", "Selamat pagi",
                    "Apa kabar?", "Salam kenal", "Hai"
                ]
            }
        }
        
        if self.config_path.exists():
            with open(self.config_path, 'r') as f:
                config = json.load(f)
                return {**default_config, **config}
        
        # Save default config
        with open(self.config_path, 'w') as f:
            json.dump(default_config, f, indent=2)
        
        return default_config
    
    async def initialize(self):
        """Initialize service components"""
        print("🚀 Initializing WU Python Service...")
        
        self.ai_generator = AIGenerator(self.config)
        self.proxy_manager = ProxyManager(self.config)
        
        print("✅ Service initialized")
    
    async def process_task(self, task: Dict[str, Any]):
        """Process a warming up task"""
        task_type = task.get('type', 'warming')
        
        if task_type == 'generate_keywords':
            count = task.get('count', 10)
            print(f"🤖 Generating {count} keywords...")
            
            keywords = await self.ai_generator.generate_batch(count)
            
            # Save keywords
            with open(self.keyword_file, 'a') as f:
                for kw in keywords:
                    json.dump({
                        'keyword': kw['keyword'],
                        'model': kw['model'],
                        'generated_at': datetime.now().isoformat()
                    }, f)
                    f.write('\n')
            
            print(f"✅ Generated {len(keywords)} keywords")
            return {'success': True, 'count': len(keywords)}
        
        elif task_type == 'warming':
            number = task.get('number')
            target = task.get('target')
            
            print(f"📱 Processing warming for {number} → {target}")
            
            # Get keyword
            keyword = await self.ai_generator.generate_keyword()
            
            # Get proxy if enabled
            proxy = None
            if self.config['proxy']['enabled']:
                proxy = self.proxy_manager.get_active_proxy()
            
            result = {
                'success': True,
                'number': number,
                'target': target,
                'keyword': keyword['keyword'],
                'model': keyword['model'],
                'proxy': proxy,
                'processed_at': datetime.now().isoformat()
            }
            
            # Save to task file for Node.js to process
            with open(self.task_file, 'a') as f:
                json.dump(result, f)
                f.write('\n')
            
            return result
        
        return {'success': False, 'error': 'Unknown task type'}
    
    async def run_forever(self):
        """Main service loop"""
        self.running = True
        
        print("\n✨ WU Service is running...")
        print("Press Ctrl+C to stop\n")
        
        # Start background tasks
        self.tasks.append(asyncio.create_task(self.keyword_generator_loop()))
        self.tasks.append(asyncio.create_task(self.proxy_check_loop()))
        self.tasks.append(asyncio.create_task(self.task_processor_loop()))
        
        try:
            # Keep running
            while self.running:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            pass
        finally:
            await self.shutdown()
    
    async def keyword_generator_loop(self):
        """Background keyword generator"""
        while self.running:
            try:
                # Check keyword count
                if self.keyword_file.exists():
                    with open(self.keyword_file, 'r') as f:
                        count = sum(1 for _ in f)
                else:
                    count = 0
                
                # Generate more if needed
                max_keywords = self.config['keywords'].get('max_ai_keywords', 100)
                if count < max_keywords and self.config['keywords'].get('auto_generate', True):
                    needed = max_keywords - count
                    print(f"📝 Generating {needed} keywords...")
                    
                    keywords = await self.ai_generator.generate_batch(min(needed, 20))
                    
                    with open(self.keyword_file, 'a') as f:
                        for kw in keywords:
                            json.dump({
                                'keyword': kw['keyword'],
                                'model': kw['model'],
                                'generated_at': datetime.now().isoformat()
                            }, f)
                            f.write('\n')
                
                # Wait before next check
                await asyncio.sleep(3600)  # Check every hour
                
            except Exception as e:
                print(f"Keyword generator error: {e}")
                await asyncio.sleep(60)
    
    async def proxy_check_loop(self):
        """Background proxy checker"""
        while self.running:
            try:
                if self.config['proxy']['enabled']:
                    is_valid = await self.proxy_manager.check_proxy()
                    if not is_valid:
                        print("⚠️ Proxy check failed")
                
                await asyncio.sleep(300)  # Check every 5 minutes
                
            except Exception as e:
                print(f"Proxy check error: {e}")
                await asyncio.sleep(60)
    
    async def task_processor_loop(self):
        """Process incoming tasks"""
        # Create a named pipe or watch for task files
        task_queue = Path("./data/task_queue.jsonl")
        
        while self.running:
            try:
                if task_queue.exists():
                    # Read and process tasks
                    tasks = []
                    with open(task_queue, 'r') as f:
                        for line in f:
                            try:
                                task = json.loads(line.strip())
                                tasks.append(task)
                            except:
                                pass
                    
                    # Clear queue
                    task_queue.unlink()
                    
                    # Process tasks
                    for task in tasks:
                        await self.process_task(task)
                
                await asyncio.sleep(1)
                
            except Exception as e:
                print(f"Task processor error: {e}")
                await asyncio.sleep(5)
    
    async def shutdown(self):
        """Graceful shutdown"""
        print("\n🛑 Shutting down...")
        
        self.running = False
        
        # Cancel all tasks
        for task in self.tasks:
            task.cancel()
        
        # Wait for tasks to complete
        await asyncio.gather(*self.tasks, return_exceptions=True)
        
        # Close AI generator session
        if self.ai_generator:
            await self.ai_generator.close()
        
        print("✅ Shutdown complete")
    
    # API Methods for external calls
    async def generate_keyword(self, prompt: str = None) -> Dict:
        """Generate single keyword"""
        return await self.ai_generator.generate_keyword(prompt)
    
    async def generate_keywords_batch(self, count: int = 10) -> list:
        """Generate batch of keywords"""
        return await self.ai_generator.generate_batch(count)
    
    def get_active_proxy(self) -> Optional[str]:
        """Get active proxy"""
        return self.proxy_manager.get_active_proxy()
    
    async def check_proxy_health(self) -> bool:
        """Check proxy health"""
        return await self.proxy_manager.check_proxy()
    
    def get_status(self) -> Dict:
        """Get service status"""
        return {
            'running': self.running,
            'ai_models': self.config['ai_models'],
            'proxy_enabled': self.config['proxy']['enabled'],
            'keywords_available': self.keyword_file.exists(),
            'timestamp': datetime.now().isoformat()
        }


async def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='WU Python Service')
    parser.add_argument('--mode', choices=['service', 'generate', 'proxy', 'status'], 
                       default='service', help='Operation mode')
    parser.add_argument('--count', type=int, default=10, 
                       help='Number of keywords to generate')
    parser.add_argument('--prompt', type=str, help='Custom prompt for generation')
    parser.add_argument('--config', type=str, default='./config.json',
                       help='Config file path')
    
    args = parser.parse_args()
    
    service = WUService(args.config)
    await service.initialize()
    
    if args.mode == 'service':
        # Setup signal handlers
        loop = asyncio.get_event_loop()
        
        def signal_handler():
            print("\n⚠️ Received interrupt signal")
            service.running = False
        
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, signal_handler)
        
        await service.run_forever()
    
    elif args.mode == 'generate':
        if args.count > 1:
            keywords = await service.generate_keywords_batch(args.count)
            print(json.dumps(keywords, indent=2, ensure_ascii=False))
        else:
            keyword = await service.generate_keyword(args.prompt)
            print(json.dumps(keyword, indent=2, ensure_ascii=False))
    
    elif args.mode == 'proxy':
        proxy = service.get_active_proxy()
        if proxy:
            print(f"Active proxy: {proxy}")
            health = await service.check_proxy_health()
            print(f"Health check: {'✅ OK' if health else '❌ Failed'}")
        else:
            print("No active proxy configured")
    
    elif args.mode == 'status':
        status = service.get_status()
        print(json.dumps(status, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
