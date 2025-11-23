# Dockerfile para VeoMaker backend (Node 18)
FROM node:18-slim

# diretório da app
WORKDIR /usr/src/app

# copiar package files first para instalar dependências em cache
COPY package.json package-lock.json* ./

# instalar dependências
RUN npm install --production=false

# copiar todo o código
COPY . .

# expor porta (informativa)
EXPOSE 8080

# comando para iniciar
CMD ["node", "index.js"]
