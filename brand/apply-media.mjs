import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(process.argv[2] || '/build/source');
const router = resolve(root, 'router/relay-router.go');
const source = await readFile(router, 'utf8');
const anchor = '\tmodelsRouter := router.Group("/v1/models")';
if (source.includes('controller.PiknoMediaUpload')) throw new Error('Media patch already applied');
if (!source.includes(anchor)) throw new Error('Media route anchor missing');
await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), 'pikno_media.go'), resolve(root,'controller/pikno_media.go'));
await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), 'pikno_media_test.go'), resolve(root,'controller/pikno_media_test.go'));
await writeFile(router, source.replace(anchor, `	mediaRouter := router.Group("/v1/media")
	mediaRouter.Use(middleware.TokenAuth(), middleware.UserCriticalRateLimit("media-upload"))
	mediaRouter.POST("/uploads", controller.PiknoMediaUpload)
	mediaRouter.POST("/complete", controller.PiknoMediaComplete)
${anchor}`));
