FROM node:20-slim
WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

# Copy server and client files
COPY server.js ./
COPY index.html ./
COPY style.css ./

EXPOSE 3000
CMD ["node", "server.js"]
