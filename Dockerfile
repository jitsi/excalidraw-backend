FROM node:12-alpine

WORKDIR /excalidraw-backend

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 80
CMD ["npm", "start"]