FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ARG SERVICE_PATH
ENV SERVICE_PATH=${SERVICE_PATH}
CMD ["sh", "-c", "node services/${SERVICE_PATH}/index.js"]
