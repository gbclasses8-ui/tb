import re
import json

with open('/tmp/target.js', 'r') as f:
    content = f.read()

apis = re.findall(r'[\'\"`](/api/[^\'\"`\s]+)[\'\"`]', content)
print('APIs found:', len(apis), sorted(list(set(apis)))[:20])

tme = re.findall(r'https?://t\.me/[^\'\"`\s]+', content)
print('Telegram links found:', sorted(list(set(tme))))

urls = re.findall(r'https?://[^\'\"`\s\<\>]+', content)
print('Total external URLs:', len(urls))
domains = set()
for u in urls:
    try:
        domains.add(u.split('/')[2])
    except:
        pass
print('Domains accessed:', sorted(list(domains)))

tb_count = len(re.findall(r'Target\s*Board', content, re.IGNORECASE))
print('Target Board occurrences:', tb_count)
