FROM node:20-slim

# Install native dependencies required by node-canvas
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (layer cache)
COPY package*.json ./

# Install node modules (canvas will compile here using the libs above)
RUN npm install

# Copy rest of source
COPY . .

EXPOSE 3000

CMD ["node", "server/src/index.js"]
