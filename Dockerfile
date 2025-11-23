FROM node:18-slim
WORKDIR /usr/src/app

# copia todo o conteúdo (mais robusto quando package.json não está na raiz correta)
COPY . .

# instala dependências
RUN npm install --production=false

# expor porta (informativa)
EXPOSE 8080

CMD ["node", "index.js"]
