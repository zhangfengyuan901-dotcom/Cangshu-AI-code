FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS check
ARG BUN_VERSION=1.3.11
ARG WEB_VERSION=v1.0.0-rc.41-hamster.51-ui
WORKDIR /build/web
RUN npm install --global --no-audit --no-fund bun@${BUN_VERSION}
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts
COPY src/ ./src/
COPY public/ ./public/
COPY index.html rsbuild.config.ts vitest.config.ts tsconfig*.json .browserslistrc .oxlintrc.json ./
COPY scripts/ ./scripts/
RUN --network=none node --test scripts/account-lite.test.mjs scripts/account-key-handoff.test.mjs scripts/account-key-activation.test.mjs scripts/account-presentation.test.mjs scripts/account-onboarding.test.mjs scripts/auth-lite.test.mjs scripts/browser-compat.test.mjs scripts/account-browser-flow.test.mjs scripts/mobile-auth-compat.test.mjs
RUN --network=none node scripts/check-trim44.mjs && bun install --frozen-lockfile --lockfile-only --ignore-scripts
RUN --network=none node --max-old-space-size=2048 node_modules/vitest/vitest.mjs run --maxWorkers=2 src/features/auth src/context/__tests__ src/components/turnstile.test.tsx src/components/layout/__tests__ src/lib/__tests__/lobe-icon.test.tsx src/lib/__tests__/pikno-storefront.test.ts src/hooks/__tests__/customer-navigation.test.tsx src/hooks/__tests__/operator-navigation.test.tsx src/hooks/__tests__/use-system-config-dedupe.test.tsx src/lib/__tests__/brand-presentation.test.tsx src/lib/__tests__/status-query.test.tsx src/lib/__tests__/dom-utils.test.ts src/lib/__tests__/lite-entry.test.ts src/routes/__tests__ src/routes/_authenticated/__tests__/developer-guide-revision.test.tsx
RUN --network=none node --max-old-space-size=2048 node_modules/vitest/vitest.mjs run --maxWorkers=2 src/features/line-management src/features/channels/components/__tests__/upstream-supplier-view.test.tsx src/features/channels/components/__tests__/rh-configuration.test.tsx
RUN --network=none ./node_modules/.bin/tsgo -b
RUN --network=none ./node_modules/.bin/oxlint -c .oxlintrc.json src/main.tsx src/hooks/use-system-config.ts src/lib/constants.ts src/lib/internal-redirect.ts src/lib/__tests__/brand-presentation.test.tsx src/features/auth/auth-layout.tsx src/features/auth/hooks/use-auth-redirect.ts src/features/auth/sign-in src/features/auth/sign-up src/features/auth/forgot-password src/components/layout/components/system-brand.tsx src/components/layout/components/footer.tsx src/routes/_authenticated/developer.tsx 'src/routes/(auth)/sign-up.tsx' 'src/routes/(auth)/forgot-password.tsx'
RUN --network=none VITE_REACT_APP_VERSION=${WEB_VERSION} ./node_modules/.bin/rsbuild build
