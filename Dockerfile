FROM node:22-bookworm AS builder

WORKDIR /usr/src/app

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build

FROM node:22-bookworm AS runner

RUN groupadd -g 1001 appuser && \
    useradd -u 1001 -g appuser -s /bin/bash -d /usr/src/app appuser

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/build ./build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./package.json

RUN chown -R appuser:appuser /usr/src/app
USER appuser

ENV NODE_ENV=production
CMD ["node", "build/index.js"]
