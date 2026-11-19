"""Switch only the www asset location from the Worker hop to the ECS runtime."""
import re


def direct_assets(content: bytes) -> bytes:
    marker = b'        location ^~ /media/v1/assets/ {\n'
    assert content.count(marker) == 1
    start = content.index(marker)
    end = content.index(b'\n        }', start)
    block = content[start:end]
    assert block.count(b'proxy_pass https://media_storage;') == 1
    assert block.count(b'proxy_set_header Host media.piknoai.com;') == 1
    assert block.count(b'proxy_set_header Cookie "";') == 1
    assert block.count(b'proxy_hide_header Set-Cookie;') == 1
    block = block.replace(b'proxy_pass https://media_storage;', b'proxy_pass http://task_control;')
    block = block.replace(b'proxy_set_header Host media.piknoai.com;', b'proxy_set_header Host www.piknoai.com;')
    block, deleted = re.subn(rb'(?m)^            proxy_ssl_[^\n]+;\n', b'', block)
    assert deleted == 5
    return content[:start] + block + content[end:]
