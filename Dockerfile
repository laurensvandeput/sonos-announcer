FROM node:16-alpine as dependencies
WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

#
# ---- Build node_modules ----
FROM node:16-alpine as prod-node-modules
WORKDIR /usr/src/app

COPY package*.json ./

# install node packages
RUN npm set progress=false && \
    npm config set depth 0 && \
    npm cache clean --force
RUN npm install --only=production

# prune for good measure
RUN npm prune --production

# ---- Compile source ----
FROM dependencies as tsc-builder
WORKDIR /usr/src/app

ARG ENVIRONMENT='production'

COPY . .

RUN npm run build

#
# ---- Release image ----
FROM node:16-alpine as release

# Add Tini
RUN apk add --no-cache tini

# set working directory
WORKDIR /usr/src/app

COPY --from=prod-node-modules /usr/src/app/node_modules node_modules
COPY --from=tsc-builder /usr/src/app/build/src .

ENV NODE_ENV production
ENV PORT 3000

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD [ "node", "index.js" ]
