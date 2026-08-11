FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

COPY . .

RUN npm run build
RUN npm --prefix server run build

ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000

CMD ["node", "server/dist/index.js"]
