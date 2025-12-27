### Build stage
FROM node:22-bookworm AS builder

WORKDIR /usr/src/app

# Enable corepack to use Yarn v4
RUN corepack enable

# Copy yarn files to cache
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Install deps (Yarn v4)
RUN yarn install --immutable

# Copy source code
COPY . .

# Build
RUN yarn build

### Runtime stage
FROM node:22-bookworm AS runner

# Enable corepack in runtime (require)
RUN corepack enable

RUN groupadd -g 1001 appuser && \
    useradd -u 1001 -g appuser -s /bin/bash -d /usr/src/app appuser

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Copy runtime files
COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/.yarnrc.yml ./
COPY --from=builder /usr/src/app/.yarn ./.yarn

# If Apollo need runtime schema
COPY --from=builder /usr/src/app/src/apollo ./src/apollo

RUN chown -R appuser:appuser /usr/src/app
USER appuser

# Start server
CMD ["yarn", "start"]
