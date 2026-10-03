FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data/pg PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
