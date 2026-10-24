FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000 TZ=America/Sao_Paulo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
VOLUME ["/app/data"]
EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
