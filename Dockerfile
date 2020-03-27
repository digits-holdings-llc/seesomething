
FROM node:13.3.0-alpine3.10


RUN apk add --no-cache tini

RUN mkdir /web
WORKDIR /web
COPY package.json package-lock.json /web/

RUN cd /web && npm install
COPY . /web
RUN mv /web/config.yaml.template /web/config.yaml


ENTRYPOINT [ "tini","--" ]
CMD ["node","/web/index.js"]