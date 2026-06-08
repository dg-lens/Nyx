FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install && pnpm --filter @nyx/arachne-server build
WORKDIR /repo/apps/arachne-server
ENV PORT=8088
EXPOSE 8088
CMD ["node", "dist/server.js"]
