# genui-relay — a tiny, dependency-light forwarder. Multi-stage: build the TS,
# ship only production deps + compiled JS on a slim runtime.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
# No lockfile is committed in the seed; the deploy repo commits one and
# switches this to `npm ci`.
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Run as the unprivileged user the base image ships.
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
