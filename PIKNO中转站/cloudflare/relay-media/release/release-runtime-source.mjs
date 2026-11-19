import {readFile} from 'node:fs/promises';
export async function runtimeSource(){return (await readFile(new URL('./worker-release.js',import.meta.url),'utf8')).replace('fetch("https://cf.api.fan" + p.path,',"fetch('https://cf.api.fan'+p.path,").replace('    const origin = request.headers.get("origin");',"    const origin = request.headers.get('origin');");}
