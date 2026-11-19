ARG BUILD_IMAGE=golang:1.26.1-alpine@sha256:2389ebfa5b7f43eeafbd6be0c3700cc46690ef842ad962f6c5bd6be49ed82039
ARG WEB_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
ARG RUNTIME_IMAGE=calciumion/new-api:v1.0.0-rc.47@sha256:938fa2713d4946723c9e9ce3076351c33f7770699fec92d23f3a26fd95791026
ARG RETAINED_WEB_IMAGE=${WEB_IMAGE}
FROM ${RETAINED_WEB_IMAGE} AS retained-web
RUN mkdir -p /retained

FROM ${WEB_IMAGE} AS web
ARG BUN_VERSION=1.3.11
ARG RELEASE_VERSION=v1.0.0-rc.41-hamster.doubao-inline-images
WORKDIR /build/web
RUN npm install --global --no-audit --no-fund bun@${BUN_VERSION}
COPY build/hamster-trim44-web/package.json build/hamster-trim44-web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts
COPY build/hamster-trim44-web/ ./
RUN --network=none VITE_REACT_APP_VERSION=${RELEASE_VERSION} bun run build

FROM ${BUILD_IMAGE} AS build
ARG RELEASE_VERSION=v1.0.0-rc.41-hamster.doubao-inline-images
ENV CGO_ENABLED=0
WORKDIR /workspace
COPY deploy/new-api/backend/go.mod deploy/new-api/backend/go.sum ./
COPY deploy/new-api/backend/relaykit/go.mod deploy/new-api/backend/relaykit/go.sum ./relaykit/
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY deploy/new-api/backend/ ./
COPY --from=retained-web /retained/ ./web/dist/
COPY --from=web /build/web/dist/ ./web/dist/
RUN --network=none --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go build -ldflags "-s -w -X github.com/QuantumNous/new-api/common.Version=${RELEASE_VERSION}" -o /client-new-api
FROM ${RUNTIME_IMAGE} AS release
COPY --from=build /client-new-api /new-api
