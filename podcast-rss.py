"""Parse public RSS bytes supplied on stdin. No network, no external packages."""
import sys, json, re, xml.etree.ElementTree as ET

payload = sys.stdin.buffer.read(6 * 1024 * 1024 + 1)
if len(payload) > 6 * 1024 * 1024 or re.search(br'<!\s*(?:DOCTYPE|ENTITY)', payload, re.I):
    raise ValueError('RSS too large or contains unsupported declarations')
root = ET.fromstring(payload)
def local(tag):
    return tag.rsplit('}', 1)[-1]
def child(node, name):
    return next((n for n in node if local(n.tag) == name), None)
def value(node, name):
    n = child(node, name)
    return ''.join(n.itertext()).strip() if n is not None else ''
channel = child(root, 'channel')
if channel is None:
    raise ValueError('Expected RSS channel')
show = value(channel, 'title')
episodes = []
for item in channel:
    if local(item.tag) != 'item':
        continue
    enclosure = child(item, 'enclosure')
    if enclosure is None or not enclosure.get('url'):
        continue
    mime = enclosure.get('type', '')
    if mime and not mime.startswith('audio/'):
        continue
    raw = value(item, 'duration')
    try:
        duration = 0
        for part in raw.split(':'):
            duration = duration * 60 + float(part)
    except ValueError:
        duration = 0
    # Known durations only: preserve host's explicit two-hour limit.
    if not 0 < duration <= 7200:
        continue
    episodes.append({'title': value(item, 'title'), 'show': show,
                     'description': value(item, 'description')[:3000],
                     'url': enclosure.get('url'), 'duration': round(duration),
                     'published': value(item, 'pubDate'), 'guid': value(item, 'guid')})
    if len(episodes) >= 500:
        break
print(json.dumps(episodes, ensure_ascii=False))
