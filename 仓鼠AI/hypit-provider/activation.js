import {createAdmissionPackageFacet} from '@hypit/hypit/admission';
import {createProducerPackageFacet} from '@hypit/hypit/producer';
import {createMarkupSurfaceFacet} from '@hypit/hypit/markup';
import {createRuntimeEndpointAdapterFacet,runtimeConfigObject,runtimeConfigExact,runtimeConfigString} from '@hypit/runtime-local/extension';
import {definition,moduleRef,surface,decodeVideoSurface} from './model.js';
import {createVideoProvider} from './provider.js';
export default {format:'hypit.package@1',modules:[{manifest:definition.manifest}],facets:[
  createProducerPackageFacet(definition.component),createAdmissionPackageFacet(definition.component),definition.facet,
  createMarkupSurfaceFacet({module:moduleRef,declaration:surface,handler:decodeVideoSurface}),
  createRuntimeEndpointAdapterFacet({use:moduleRef.name,activate(context){
    const config=runtimeConfigObject(context.config,'仓鼠视频适配');runtimeConfigExact(config,['projectId'],'仓鼠视频适配');
    const projectId=runtimeConfigString(config.projectId,'projectId'),baseUrl=process.env.HAMSTER_HYPIT_BRIDGE_URL,token=process.env.HAMSTER_HYPIT_BRIDGE_TOKEN;
    if(!projectId||!context.pool||!baseUrl||!token)throw new Error('请从仓鼠打开 Hypit 视频运行环境');
    return {endpoint:createVideoProvider({instance:context.instance,pool:context.pool,projectId,baseUrl,token})};
  }}),
]};
