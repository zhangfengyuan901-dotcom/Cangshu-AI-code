"""Produce a narrow, verified TOS route patch from the supplied ingress configuration."""
import argparse
from pathlib import Path


def candidate(content):
    marker = '        server_name origin.piknoai.com;\n'
    end_route = '        location / { return 404; }\n'
    assert content.count(marker) == 1
    start = content.index(marker)
    finish = content.index(end_route, start)
    assert 'location = /media/v1/packy { proxy_pass http://task_control; }' in content[start:finish]
    assert '/media/v1/storage-tos/' not in content
    route = (
        '        location ^~ /media/v1/storage-tos/ {\n'
        '            client_max_body_size 1024m;\n'
        '            proxy_pass http://task_control;\n'
        '        }\n'
    )
    return content[:finish] + route + content[finish:]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    with args.output.open('x', encoding='utf-8', newline='\n') as output:
        output.write(candidate(args.source.read_text(encoding='utf-8')))
