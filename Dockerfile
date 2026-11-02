# node:sqlite needs Node 22.13 or newer.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY seed ./seed

# Mount permanent storage here, or every deploy deletes all accounts, bookings and photos.
ENV DATA_DIR=/data
ENV PORT=4100
EXPOSE 4100

CMD ["node", "src/index.js"]
