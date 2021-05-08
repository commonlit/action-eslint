FROM node:16-alpine

ENV REVIEWDOG_VERSION=v0.11.0

RUN wget -O - -q https://raw.githubusercontent.com/reviewdog/reviewdog/master/install.sh| sh -s -- -b /usr/local/bin/ ${REVIEWDOG_VERSION}

RUN apk --no-cache add jq git
RUN apk --no-cache add build-base python2

COPY entrypoint.sh /entrypoint.sh
COPY eslint-formatter-rdjson/index.js /formatter.js

ENTRYPOINT ["/entrypoint.sh"]
