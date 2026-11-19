ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
FROM ${NODE_IMAGE}

WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
RUN mkdir -p /data/diagnostics && chown -R node:node /data

ENV NODE_ENV=production
USER node
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --retries=5 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/pay/lanjing/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
