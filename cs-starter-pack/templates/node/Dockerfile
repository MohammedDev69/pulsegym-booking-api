# Node.js template. Your entry file is src/index.js (change CMD if needed).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
