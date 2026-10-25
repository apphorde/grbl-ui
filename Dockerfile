FROM ghcr.io/cloud-cli/image-node:latest
WORKDIR /home/app
COPY package.json ./
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server.mjs ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
