FROM node:20-slim
WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

# Copy server and public files
COPY server.js ./
COPY public/ ./public/

EXPOSE 3000
CMD ["node", "server.js"]
