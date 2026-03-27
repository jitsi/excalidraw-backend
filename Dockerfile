FROM node:24-slim

WORKDIR /excalidraw-backend

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 80
EXPOSE 9090

CMD ["npm", "start"]