FROM node:lts-slim

WORKDIR /excalidraw-backend

COPY package.json package-lock.json tsconfig.json src ./
RUN npm install
RUN npm run build

EXPOSE 80
EXPOSE 9090

CMD ["npm", "start"]