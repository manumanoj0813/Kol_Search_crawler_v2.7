# https://docs.apify.com/sdk/js/docs/guides/docker-images
FROM apify/actor-node:24

# Copy just package.json and package-lock.json to leverage layer cache.
COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy the remaining source. Secrets are excluded via .dockerignore.
COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
