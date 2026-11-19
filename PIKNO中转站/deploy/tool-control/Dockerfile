FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
WORKDIR /app
COPY deploy/tool-control/package.json deploy/tool-control/protocol.mjs deploy/tool-control/runtime.mjs deploy/tool-control/server.mjs deploy/tool-control/storage-client.mjs deploy/tool-control/worker-candidate.mjs ./deploy/tool-control/
COPY deploy/tool-control/tos-migration/storage.mjs deploy/tool-control/tos-migration/proxy.mjs deploy/tool-control/tos-migration/server.mjs deploy/tool-control/tos-migration/asset-runtime.mjs deploy/tool-control/tos-migration/presign-route.mjs deploy/tool-control/tos-migration/presigned-upload.mjs ./deploy/tool-control/tos-migration/
RUN node --input-type=module -e "import('./deploy/tool-control/runtime.mjs').then(m=>m.loadRuntime())"
USER node
ENV CONTROL_BIND=0.0.0.0 CONTROL_PORT=8090 CONTROL_OWNER=blocked
CMD ["node", "deploy/tool-control/tos-migration/server.mjs"]
