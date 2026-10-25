FROM ghcr.io/cloud-cli/image-node:latest
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
