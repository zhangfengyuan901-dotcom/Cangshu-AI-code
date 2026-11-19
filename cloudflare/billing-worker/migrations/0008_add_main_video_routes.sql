INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at)
VALUES ('main-video-480real','main','video','主线路 · 480P 真人','fixed',3000000,6000000,
'{"resolutions":["480p"],"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"ratios":["16:9","9:16","1:1"],"max_images":9,"max_videos":3,"max_audios":3,"max_media_files":15,"max_prompt_characters":10000}',1,1,0);
INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at)
VALUES ('main-video-933limited','main','video','主线路 · 720P 限量','fixed',4000000,8000000,
'{"resolutions":["720p"],"durations":[4,5,6,7,8,9,10,11,12,13,14,15],"ratios":["1:1","16:9","9:16","4:3","3:4"],"max_images":9,"max_videos":0,"max_audios":3,"max_media_files":12,"max_prompt_characters":10000}',1,1,0);
INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at)
VALUES ('main-video-value','main','video','主线路 · 720P 性价比','fixed',4000000,8000000,
'{"resolutions":["720p"],"durations":[15],"ratios":["16:9","9:16","21:9"],"max_images":9,"max_videos":0,"max_audios":0,"max_media_files":9,"max_prompt_characters":10000}',1,1,0);
INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at)
VALUES ('main-video-line5','main','video','主线路 · 灵活多素材','per_second',720000,1000000,
'{"resolutions":["720p","480p"],"durations":[4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"ratios":["21:9","16:9","4:3","1:1","3:4","9:16"],"max_images":30,"max_videos":10,"max_audios":10,"max_media_files":50,"max_prompt_characters":10000,"cost_by_resolution":{"480p":550000,"720p":720000}}',1,1,0);
INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at)
VALUES ('main-video-line1','main','video','主线路 · 轻量多素材','per_second',550000,1000000,
'{"resolutions":["720p","480p"],"durations":[4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"ratios":["1:1","3:4","4:3","9:16","16:9","21:9"],"max_images":30,"max_videos":0,"max_audios":10,"max_media_files":40,"max_prompt_characters":10000,"cost_by_resolution":{"480p":370000,"720p":550000}}',1,1,0);
