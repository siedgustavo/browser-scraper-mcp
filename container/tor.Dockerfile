FROM alpine:3.21

RUN apk add --no-cache bash tor

COPY tor-entrypoint.sh /usr/local/bin/tor-entrypoint.sh
RUN chmod +x /usr/local/bin/tor-entrypoint.sh

EXPOSE 9050 9051

ENTRYPOINT ["/usr/local/bin/tor-entrypoint.sh"]
