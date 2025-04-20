FROM node:22-alpine AS builder

WORKDIR /app

COPY . .
RUN npm install
RUN npm run build

FROM builder AS app
CMD ["node", "server.js"]

FROM builder AS discovery-svc
CMD ["node", "dist/discovery-server.js"]
