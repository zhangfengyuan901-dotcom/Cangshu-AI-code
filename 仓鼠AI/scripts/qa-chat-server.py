"""Isolated local UI fixture. No credentials and no paid inference."""
import io
import os
import sys
from pathlib import Path
from fastapi.responses import Response
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'smart-video-agent'))
import studio
from test_chat import fake_client, Stream
import uvicorn

studio.configured_keys = lambda: {'MODEL_AGENT_API_KEY':'offline-fixture','SANBAO_API_KEY':''}
os.environ['HAMSTER_ASSET_API'] = 'http://127.0.0.1:8006/fixture-assets'
directory = ROOT/'output'/'playwright'/'chat-qa'
app = studio.create_studio(directory=directory/'studio', output=directory/'results')
client = fake_client()
client.responses.create.side_effect = lambda **k: Stream('这是一段离线测试回答。\n\n**素材已理解**\n我们可以围绕图片、视频和产品说明继续讨论。\n\n1. 保留人物与产品的一致性。\n2. 明确画面节奏和创作方向。\n\n你希望先完善哪一部分？', delay=1)
app.state.chat.client_factory = lambda: client
buffer = io.BytesIO()
Image.new('RGB', (320,240), '#bec8b1').save(buffer, format='PNG')
image = buffer.getvalue()
directory.mkdir(parents=True, exist_ok=True)
(directory/'product.png').write_bytes(image)
(directory/'产品说明.txt').write_text('白色连衣裙，轻盈棉质面料，日常通勤。', encoding='utf-8')
root_route = app.routes.pop()
@app.get('/fixture-assets')
async def assets():
    return {'root':'离线测试资产库','items':[{'id':'a'*32,'name':'测试产品.png','category':'product','kind':'image','size':len(image)}]}
@app.get('/fixture-assets/{ident}/file')
async def asset_file(ident: str):
    return Response(image, media_type='image/png')
app.routes.append(root_route)
uvicorn.run(app, host='127.0.0.1', port=8006)
