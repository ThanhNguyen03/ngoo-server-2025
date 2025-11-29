FROM node:22-bookworm AS builder

WORKDIR /usr/src/app

# Copy package files & install deps
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy all source code (src + config) for build
COPY . .

RUN yarn build

FROM node:22-bookworm AS runner

RUN groupadd -g 1001 appuser && \
    useradd -u 1001 -g appuser -s /bin/bash -d /usr/src/app appuser

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./package.json

COPY --from=builder /usr/src/app/src/**/*.graphql ./src/

RUN chown -R appuser:appuser /usr/src/app
USER appuser

ENV NODE_ENV=prod

# Start the server
CMD ["node", "build/index.js"]
