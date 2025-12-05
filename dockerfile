FROM node:22-slim

# Instala o poppler-utils (pdftoppm, pdftocairo, etc.)
RUN apt-get update && apt-get install -y poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
