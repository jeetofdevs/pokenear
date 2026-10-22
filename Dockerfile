# Railway (or any Docker host): the server has no runtime dependencies, so nothing is installed.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY . .
EXPOSE 3000
CMD ["node", "server/server.js"]
