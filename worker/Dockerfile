FROM golang:1.25-alpine AS build

WORKDIR /src
COPY worker/go.mod worker/go.sum ./
RUN go mod download
COPY worker/*.go ./
COPY worker/migrations ./migrations
COPY worker/assets ./assets
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/konakore-worker .

FROM alpine:3.23

RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/konakore-worker /usr/local/bin/konakore-worker

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8090/health || exit 1

CMD ["konakore-worker"]
