# Backend image. Multi-stage so the runtime layer carries no build tooling and
# no dev dependencies, which is the difference between a 1.2GB image and a
# small one, and between shipping a test framework to production and not.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY spec ./spec
COPY sut/backend ./sut/backend
COPY sut/frontend ./sut/frontend

# Runs as a non-root user. `node` exists in the base image already.
USER node
EXPOSE 8080

# A container that reports healthy only once the exchange answers, so a
# compose dependency on it means something.
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=15 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "sut/backend/main.ts"]
