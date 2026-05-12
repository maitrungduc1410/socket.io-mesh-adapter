FROM node:22-alpine AS builder

WORKDIR /app

COPY . .
RUN npm install
RUN npm run build

FROM builder AS app
CMD ["npx", "tsx", "server.ts"]

FROM builder AS discovery-svc
CMD ["node", "dist/discovery/discovery-server.js"]
