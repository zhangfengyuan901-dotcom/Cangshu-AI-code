// Internal routing only. Public model identifiers never contain provider identifiers.
const routes={
 'main-video-720':'sd_2_5_once_720p',
 'main-video-flex':'sd_2_5_once_line3',
 'main-video-30':'sd_2_5_900_30s',
 'main-video-480real':'sd2_480p_real',
 'main-video-933limited':'sd2_933_limited_line',
 'main-video-value':'sd2_value',
 'main-video-line5':'sd2_5_line5',
 'main-video-line1':'sd2_5_limited_line1',
 'backup-video-480':'doubao-seedance-2-5',
 'main-image-a':'image_2_5_flare',
 'main-image-b':'image_2_5_sunburst',
 'main-image-c':'gpt-image2',
 'main-image-1k':'gpt-image2-1K',
 'main-image-2k':'gpt-image2-2K',
 'main-image-4k':'gpt-image2-4K',
};
export function upstreamModel(id){if(!routes[id])throw Object.assign(new Error('线路未开放'),{status:400});return routes[id];}
