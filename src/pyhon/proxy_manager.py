import asyncio
import aiohttp
import random
from datetime import datetime, time
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field


@dataclass
class Proxy:
    """Proxy configuration"""
    url: str
    protocol: str = 'http'
    host: str = ''
    port: int = 80
    username: Optional[str] = None
    password: Optional[str] = None
    start_time: int = 0
    end_time: int = 24
    priority: int = 1
    usage_count: int = 0
    fail_count: int = 0
    last_used: Optional[datetime] = None
    last_check: Optional[datetime] = None
    is_active: bool = True
    response_time: float = 0.0
    
    def __post_init__(self):
        if not self.host and self.url:
            self._parse_url()
    
    def _parse_url(self):
        """Parse proxy URL"""
        try:
            from urllib.parse import urlparse
            parsed = urlparse(self.url)
            self.protocol = parsed.scheme or 'http'
            self.host = parsed.hostname or ''
            self.port = parsed.port or (443 if self.protocol == 'https' else 80)
            
            if parsed.username:
                self.username = parsed.username
                self.password = parsed.password
        except:
            pass
    
    def get_formatted_url(self) -> str:
        """Get formatted proxy URL"""
        if self.username and self.password:
            auth = f"{self.username}:{self.password}@"
        else:
            auth = ""
        
        return f"{self.protocol}://{auth}{self.host}:{self.port}"
    
    def is_time_valid(self) -> bool:
        """Check if proxy is within active time window"""
        current_hour = datetime.now().hour
        
        if self.start_time == self.end_time:
            return True
        
        if self.start_time < self.end_time:
            return self.start_time <= current_hour < self.end_time
        else:
            return current_hour >= self.start_time or current_hour < self.end_time


class ProxyManager:
    """Proxy rotation and management"""
    
    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        self.proxies: List[Proxy] = []
        self.current_index = 0
        self.session: Optional[aiohttp.ClientSession] = None
        self.test_url = "http://httpbin.org/ip"
        self.test_timeout = 10
        
        self._load_proxies()
    
    def _load_proxies(self):
        """Load proxies from config"""
        proxy_config = self.config.get('proxy', {})
        
        if not proxy_config.get('enabled', False):
            return
        
        # Load single proxy from config
        if proxy_config.get('url'):
            proxy = Proxy(
                url=proxy_config['url'],
                start_time=proxy_config.get('start_time', 0),
                end_time=proxy_config.get('end_time', 24)
            )
            self.proxies.append(proxy)
        
        # Load multiple proxies if available
        proxy_list = proxy_config.get('list', [])
        for p in proxy_list:
            proxy = Proxy(
                url=p.get('url', ''),
                start_time=p.get('start_time', 0),
                end_time=p.get('end_time', 24),
                priority=p.get('priority', 1)
            )
            self.proxies.append(proxy)
        
        print(f"📡 Loaded {len(self.proxies)} proxies")
    
    def add_proxy(self, url: str, start_time: int = 0, end_time: int = 24) -> Proxy:
        """Add a new proxy"""
        proxy = Proxy(url=url, start_time=start_time, end_time=end_time)
        self.proxies.append(proxy)
        return proxy
    
    def remove_proxy(self, url: str) -> bool:
        """Remove a proxy"""
        for i, proxy in enumerate(self.proxies):
            if proxy.url == url:
                self.proxies.pop(i)
                return True
        return False
    
    def get_active_proxy(self) -> Optional[str]:
        """Get an active proxy based on time and priority"""
        valid_proxies = []
        
        for proxy in self.proxies:
            if proxy.is_active and proxy.is_time_valid():
                valid_proxies.append(proxy)
        
        if not valid_proxies:
            return None
        
        # Sort by priority (higher priority first) and then by usage count
        valid_proxies.sort(key=lambda p: (-p.priority, p.usage_count, p.fail_count))
        
        # Get proxy with least usage
        proxy = valid_proxies[0]
        proxy.usage_count += 1
        proxy.last_used = datetime.now()
        
        return proxy.get_formatted_url()
    
    def get_all_active_proxies(self) -> List[str]:
        """Get all currently active proxies"""
        active = []
        for proxy in self.proxies:
            if proxy.is_active and proxy.is_time_valid():
                active.append(proxy.get_formatted_url())
        return active
    
    async def check_proxy(self, proxy_url: str = None) -> bool:
        """Check if a proxy is working"""
        if proxy_url is None:
            proxy_url = self.get_active_proxy()
            if not proxy_url:
                return False
        
        try:
            if self.session is None:
                timeout = aiohttp.ClientTimeout(total=self.test_timeout)
                self.session = aiohttp.ClientSession(timeout=timeout)
            
            start_time = datetime.now()
            
            async with self.session.get(
                self.test_url,
                proxy=proxy_url,
                ssl=False
            ) as response:
                response_time = (datetime.now() - start_time).total_seconds()
                
                if response.status == 200:
                    # Update proxy stats
                    for proxy in self.proxies:
                        if proxy.get_formatted_url() == proxy_url:
                            proxy.response_time = response_time
                            proxy.last_check = datetime.now()
                            proxy.fail_count = 0
                    
                    return True
                
        except Exception as e:
            print(f"Proxy check failed: {e}")
            
            # Update fail count
            for proxy in self.proxies:
                if proxy.get_formatted_url() == proxy_url:
                    proxy.fail_count += 1
                    proxy.last_check = datetime.now()
                    
                    # Deactivate if too many failures
                    if proxy.fail_count >= 3:
                        proxy.is_active = False
                        print(f"⚠️ Deactivated proxy {proxy_url} after {proxy.fail_count} failures")
        
        return False
    
    async def check_all_proxies(self) -> Dict[str, bool]:
        """Check all proxies"""
        results = {}
        
        for proxy in self.proxies:
            url = proxy.get_formatted_url()
            results[url] = await self.check_proxy(url)
            
            # Small delay between checks
            await asyncio.sleep(0.5)
        
        return results
    
    async def rotate_proxy(self) -> Optional[str]:
        """Rotate to next available proxy"""
        valid_proxies = [p for p in self.proxies if p.is_active and p.is_time_valid()]
        
        if not valid_proxies:
            return None
        
        self.current_index = (self.current_index + 1) % len(valid_proxies)
        proxy = valid_proxies[self.current_index]
        
        # Check if proxy is working
        if await self.check_proxy(proxy.get_formatted_url()):
            proxy.usage_count += 1
            proxy.last_used = datetime.now()
            return proxy.get_formatted_url()
        
        # Try next proxy
        return await self.rotate_proxy()
    
    def get_proxy_stats(self) -> List[Dict[str, Any]]:
        """Get statistics for all proxies"""
        stats = []
        
        for proxy in self.proxies:
            stats.append({
                'url': proxy.url[:30] + '...' if len(proxy.url) > 30 else proxy.url,
                'protocol': proxy.protocol,
                'is_active': proxy.is_active,
                'time_valid': proxy.is_time_valid(),
                'time_window': f"{proxy.start_time:02d}:00 - {proxy.end_time:02d}:00",
                'usage_count': proxy.usage_count,
                'fail_count': proxy.fail_count,
                'response_time': round(proxy.response_time, 2),
                'last_used': proxy.last_used.isoformat() if proxy.last_used else None,
                'last_check': proxy.last_check.isoformat() if proxy.last_check else None
            })
        
        return stats
    
    def get_best_proxy(self) -> Optional[str]:
        """Get the best performing proxy"""
        valid_proxies = [
            p for p in self.proxies 
            if p.is_active and p.is_time_valid() and p.response_time > 0
        ]
        
        if not valid_proxies:
            return self.get_active_proxy()
        
        # Sort by response time
        valid_proxies.sort(key=lambda p: p.response_time)
        
        proxy = valid_proxies[0]
        proxy.usage_count += 1
        proxy.last_used = datetime.now()
        
        return proxy.get_formatted_url()
    
    def reset_all_proxies(self):
        """Reset all proxies to active"""
        for proxy in self.proxies:
            proxy.is_active = True
            proxy.fail_count = 0
    
    async def close(self):
        """Close HTTP session"""
        if self.session and not self.session.closed:
            await self.session.close()
    
    def is_proxy_enabled(self) -> bool:
        """Check if proxy is enabled in config"""
        return self.config.get('proxy', {}).get('enabled', False) and len(self.proxies) > 0


# CLI for testing
async def test_proxy_manager():
    """Test the proxy manager"""
    config = {
        'proxy': {
            'enabled': True,
            'url': 'http://localhost:8080',
            'start_time': 0,
            'end_time': 24
        }
    }
    
    manager = ProxyManager(config)
    
    print("📡 Testing Proxy Manager...\n")
    
    print(f"Proxy enabled: {manager.is_proxy_enabled()}")
    print(f"Active proxy: {manager.get_active_proxy()}")
    
    print("\nChecking proxy...")
    is_working = await manager.check_proxy()
    print(f"Status: {'✅ Working' if is_working else '❌ Failed'}")
    
    print("\n📊 Proxy Stats:")
    for stat in manager.get_proxy_stats():
        print(f"  {stat['url']}")
        print(f"    Active: {stat['is_active']}")
        print(f"    Time valid: {stat['time_valid']}")
        print(f"    Usage: {stat['usage_count']}")
        print(f"    Fails: {stat['fail_count']}")
    
    await manager.close()


if __name__ == '__main__':
    asyncio.run(test_proxy_manager())
